import fs from "node:fs";
import { callJSON, stepUp } from "../llm.ts";
import type { Ambiguity, BBox, Category, DrawingModel, Endpoint, Item, Line, SignalLink } from "../types.ts";
import type { RunContext } from "./context.ts";
import { blocks, center, cropForModel } from "./images.ts";
import type { PageImage } from "./locate.ts";
import { enrichInstruments, type LineLabel } from "./digitize.ts";
import { assignIds, normTag, safeId } from "./merge.ts";
import type { Token } from "./ocr.ts";
import { CONNECT_SCHEMA, systemPrompt } from "./prompts.ts";
import { applyGeometry, closeOpenEnds, computeNets, drawNets, fitBubbles, fitEquipment, labelLeaders, joinDrawnPipes, nozzleLabels, tagsFromText, linkByNets, netAgreement, netEvidence, placeOrphans } from "./vectorlayer.ts";
import { linkInstruments } from "./instlinks.ts";
import { writeDrawingXml } from "./xml.ts";

interface NewItem {
  key: string;
  tag: string | null;
  category: Category;
  type: string;
  dexpi_class: string | null;
  description: string | null;
  at: number[];
  reason: string;
}
interface ConnectReply {
  lines: (Omit<Line, "id" | "page"> & { key: string })[];
  new_items?: NewItem[];
  instrument_links: SignalLink[];
  ambiguities: Ambiguity[];
}

/** Messages this stage writes itself (so a re-run can replace them). */
export const CONNECT_MESSAGES = [/^Branch target run '.*' does not exist/, /^End point '.*' is not a known item/, /^Run lists unknown component ids/, /^Placed on both .* and .*; kept on/, /^No line from these instruments to a pipe/];

const area = (b: BBox) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
function iou(a: BBox, b: BBox) {
  const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return i / (area(a) + area(b) - i);
}

/**
 * Untagged items of the same kind stacked on one spot (the merge kept four readings of one hose)
 * would each need a place on a run. Keep one. Returns the dropped ids.
 */
export function dropStackedDuplicates(model: DrawingModel) {
  const gone: string[] = [];
  const keep: Item[] = [];
  for (const it of model.items) {
    const twin = !it.tag && it.category !== "equipment" ? keep.find((k) => !k.tag && k.page === it.page && k.category === it.category && k.type === it.type && iou(k.bbox, it.bbox) > 0.5) : undefined;
    if (twin) {
      twin.sources.push(...it.sources);
      gone.push(it.id);
    } else keep.push(it);
  }
  model.items = keep;
  return gone;
}

/**
 * Trace pipe runs and instrument links for each page. The model sees the whole sheet plus
 * four quadrant close-ups, and the merged item list with positions, so it can refer to items by id.
 * Symbols it needs but cannot find in the list (a valve body next to its continuation label,
 * a second bubble with the same tag, a connector) it adds as new items.
 */
export async function connect(ctx: RunContext) {
  const model = ctx.bag.model as DrawingModel;
  const pages = ctx.bag.pages as PageImage[];
  const labels = (ctx.bag.lineLabels as LineLabel[]) ?? [];
  const local = (ctx.bag.localConnections as { page: number; from: string; to: string; via: string | null }[]) ?? [];
  const tokens = (ctx.bag.ocrTokens as Token[] | undefined) ?? readTokens(ctx);
  const system = systemPrompt(ctx.settings, model.standard);

  const stacked = dropStackedDuplicates(model);
  if (stacked.length) ctx.log("connect", `${stacked.length} stacked duplicate readings dropped: ${stacked.join(", ")}`);

  // equipment boxes to their drawn outline, instrument boxes to their drawn circle first, so lines leaving a bubble reach it
  const outlined = fitEquipment(ctx, model, pages);
  if (outlined.length) ctx.log("connect", `vector layer: ${outlined.length} equipment boxes set to their drawn outline: ${outlined.join("; ")}`);
  const moved = labelLeaders(ctx, model, pages);
  if (moved.length) ctx.log("connect", `vector layer: ${moved.length} tags read on their label moved along the leader to the symbol: ${moved.join("; ")}`);
  const tagged = tagsFromText(ctx, model, pages);
  if (tagged.length) ctx.log("connect", `vector layer: ${tagged.length} instruments without tag take their printed letter code: ${tagged.join(", ")}`);
  const fitted = fitBubbles(ctx, model, pages);
  if (fitted) ctx.log("connect", `vector layer: ${fitted} instrument boxes set to their drawn bubble`);
  // vector layer: the drawn lines of the PDF, cut at every symbol (nothing on a scanned sheet)
  const netsByPage = computeNets(ctx, model, pages);
  for (const page of pages) {
    const n = netsByPage.get(page.n);
    if (n) await drawNets(page.file, ctx.path("work", `nets_p${page.n}.png`), page.W, page.H, n, model.items.filter((i) => i.page === page.n)).catch(() => {});
  }

  let added = 0;
  for (const page of pages) {
    const items = model.items.filter((i) => i.page === page.n);
    const overview = await cropForModel(page.file, { x: 0, y: 0, w: page.W, h: page.H });
    const quads = blocks(page.n, page.W, page.H, 2, 2, 0.06, "q");
    const quadImgs = await Promise.all(quads.map((q) => cropForModel(page.file, q)));
    const norm = (x: number, y: number) => `(${Math.round((x / page.W) * 1000)},${Math.round((y / page.H) * 1000)})`;
    const list = items
      .map((i) => {
        const [cx, cy] = center(i.bbox);
        return `${i.id}\t${i.category}\t${i.type}${i.tag ? `\ttag=${i.tag}` : ""}${i.service ? `\tservice=${i.service}` : ""}\tat ${norm(cx, cy)}`;
      })
      .join("\n");
    const labelList = labels
      .filter((l) => l.page === page.n)
      .map((l) => `"${l.text}" at ${norm(...center(l.bbox))}`)
      .join("\n");
    const localList = local
      .filter((c) => c.page === page.n)
      .map((c) => `${c.from} → ${c.to}${c.via ? ` via ${c.via}` : ""}`)
      .join("\n");

    const nets = netsByPage.get(page.n);
    const evidence = nets ? netEvidence(nets, model, norm) : "";
    const prompt = `You are tracing the piping of this P&ID sheet. Image 1 is the whole sheet; images 2–5 are its quadrants (top-left, top-right, bottom-left, bottom-right) at higher resolution.

These items were already found on the sheet (id, category, type, tag, position as (x,y) on a 0–1000 grid of the whole sheet):
${list}

Printed line labels found:
${labelList || "(none)"}

Connections that tile readers saw locally (tags as printed, may contain duplicates or errors):
${localList || "(none)"}
${
  evidence
    ? `
Drawn lines taken from the PDF's vector geometry (exact). Each net is one connected drawn line with every symbol cut out, so a pipe stops at each valve or component it runs into: a valve on a run sits between two pipe nets, and the items a net lists are joined by that drawn line. 'dashed'/'thin' nets are signal or impulse lines; 'ends on' = it ends on another line (a tap or a tee); 'loose end' = it reaches no listed item (an open end, or a symbol missing from the list). Treat this as strong evidence for what is connected to what; take the flow order and the meaning from the image. Item boxes can be a little off, so a net may name a neighbouring item.
${evidence}
`
    : ""
}
Tasks:
1. Follow every process and utility pipe. Report each run between two end points as one line: from/to are equipment or off-page items (by id), another run (kind=line, a branch/tee, with 'after' = the component on that run after which the branch joins), or 'open' for an open pipe end / vent / drain without a connector. List the ids of the valves and piping components ON the run in flow order. A crossing without a dot or bridge is not a connection. Do not report the same run twice.
2. Link instruments: 'measures' (instrument → run key or equipment id it senses), 'actuates' (controller → valve id it drives, only when the signal line is visible), 'signal' (instrument → instrument). A short impulse/tap line from a process pipe to an instrument (with its root valve) is not a run: link the instrument as 'measures' the run it taps.
3. Refer to listed items by their id. A symbol you trace through or link to that is NOT in the list — a valve body whose tag also appears as a continuation label elsewhere, a second bubble carrying the same tag, a connector or reducer — goes in new_items with key N1, N2, … and its centre; use that key in runs and links. Add only symbols you can see; never add one just to close a gap.
4. Connectors at the sheet edge with no drawn pipe to the process need no run and no remark.
5. Anything you cannot follow with confidence goes in ambiguities, one actionable sentence each.`;

    const reply = await callJSON<ConnectReply>(ctx, {
      stage: "connect",
      label: `topology page ${page.n}`,
      system,
      prompt,
      images: [
        { data: overview.data, mediaType: "image/png", caption: "Image 1 — whole sheet:" },
        ...quadImgs.map((q, i) => ({ data: q.data, mediaType: "image/png" as const, caption: `Image ${i + 2} — quadrant ${["top-left", "top-right", "bottom-left", "bottom-right"][i]}:` })),
      ],
      schema: CONNECT_SCHEMA,
      effort: stepUp(ctx.settings.effort),
      maxTokens: 64000,
    });
    ctx.writeJSON(`work/connect_page${page.n}.json`, reply);

    // new items → real items with ids
    const keyToItem = new Map<string, string>();
    const fresh = (reply.new_items ?? []).map((n) => newItem(n, page, items, tokens));
    for (const [k, n] of (reply.new_items ?? []).entries()) {
      const f = fresh[k];
      // already listed after all (same tag, close by)? use that one
      const same = f.tag ? items.find((i) => normTag(i.tag) === normTag(f.tag) && Math.hypot(center(i.bbox)[0] - center(f.bbox)[0], center(i.bbox)[1] - center(f.bbox)[1]) < 0.03 * Math.hypot(page.W, page.H)) : undefined;
      if (same) {
        keyToItem.set(n.key, same.id);
        fresh[k] = undefined as unknown as Item;
      }
    }
    const toAdd = fresh.filter(Boolean);
    if (toAdd.length) {
      const taken = new Set(model.items.map((i) => i.id));
      assignIds(toAdd);
      for (const f of toAdd) {
        const base = f.id.replace("-auto-", "-con-");
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
        f.id = id;
        taken.add(id);
      }
      (reply.new_items ?? []).forEach((n, k) => fresh[k] && keyToItem.set(n.key, fresh[k].id));
      model.items.push(...toAdd);
      items.push(...toAdd);
      added += toAdd.length;
    }

    // a component named by its printed tag that the item list lacks (FLX814 next to FLX806 …):
    // when OCR sees that tag on the sheet, add it there, typed like its tag family
    const known = new Set([...items.map((i) => i.id), ...keyToItem.keys(), ...items.map((i) => normTag(i.tag))]);
    for (const ref of new Set(reply.lines.flatMap((l) => l.components))) {
      const nt = normTag(ref);
      if (!nt || known.has(ref) || known.has(nt) || !/^[A-Z]{1,5}\d{2,4}[A-Z]?$/.test(nt)) continue;
      const tok = tokens.find((t) => t.page === page.n && t.norm === nt);
      const family = items.find((i) => i.tag && normTag(i.tag)!.replace(/\d.*$/, "") === nt.replace(/\d.*$/, "") && i.category !== "instrument");
      if (!tok || !family) continue;
      const side = Math.max(family.bbox[2] - family.bbox[0], family.bbox[3] - family.bbox[1]);
      const [x, y] = center(tok.box);
      const it: Item = {
        ...family,
        id: safeId(ref),
        tag: ref,
        description: null,
        line_ref: null,
        loop: null,
        bbox: [x - side / 2, y - side / 2, x + side / 2, y + side / 2].map(Math.round) as BBox,
        confidence: 0.5,
        sources: [`connect-p${page.n}`],
        note: `named on a run by the tracer and printed on the sheet (OCR), typed like ${family.tag}`,
      };
      if (model.items.some((i) => i.id === it.id)) continue;
      model.items.push(it);
      items.push(it);
      known.add(ref);
      added++;
    }

    // resolve a reference: id, new-item key, or a tag written instead of the id
    const ids = new Set(items.map((i) => i.id));
    const byTag = new Map<string, string[]>();
    for (const i of items) if (normTag(i.tag)) byTag.set(normTag(i.tag)!, [...(byTag.get(normTag(i.tag)!) ?? []), i.id]);
    const resolve = (ref: string | null) => {
      if (!ref) return null;
      if (ids.has(ref)) return ref;
      if (keyToItem.has(ref)) return keyToItem.get(ref)!;
      const t = byTag.get(normTag(ref) ?? "");
      return t?.length === 1 ? t[0] : null;
    };

    // validate references and translate keys to stable line ids
    const keyToId = new Map<string, string>();
    reply.lines.forEach((l, k) => keyToId.set(l.key, `L${page.n}-${String(k + 1).padStart(3, "0")}`));
    const fixEp = (e: Endpoint, lineKey: string): Endpoint => {
      if (e.kind === "line") {
        const ref = e.ref && keyToId.get(e.ref);
        if (!ref) {
          model.ambiguities.push({ tag: lineKey, issue: `Branch target run '${e.ref}' does not exist; branch left open.` });
          return { kind: "open", ref: null, after: null };
        }
        return { kind: "line", ref, after: resolve(e.after) };
      }
      if (e.kind === "equipment" || e.kind === "off_page") {
        const ref = resolve(e.ref);
        if (!ref) {
          model.ambiguities.push({ tag: lineKey, issue: `End point '${e.ref}' is not a known item; check where this run ends.` });
          return { kind: "open", ref: e.ref, after: null };
        }
        return { ...e, ref };
      }
      return e;
    };
    for (const l of reply.lines) {
      const id = keyToId.get(l.key)!;
      const comps = l.components.map((c) => [c, resolve(c)] as const);
      const unknown = comps.filter(([, r]) => !r).map(([c]) => c);
      if (unknown.length) model.ambiguities.push({ tag: id, issue: `Run lists unknown component ids ${unknown.join(", ")}; they were dropped.` });
      model.lines.push({
        id,
        page: page.n,
        line_id: l.line_id,
        size: l.size,
        spec: l.spec,
        service: l.service,
        from: fixEp(l.from, id),
        to: fixEp(l.to, id),
        components: [...new Set(comps.flatMap(([, r]) => (r ? [r] : [])))],
        insulation: l.insulation,
        confidence: l.confidence,
      });
    }
    for (const s of reply.instrument_links) {
      const instrument = resolve(s.instrument);
      const target = keyToId.get(s.target) ?? resolve(s.target);
      if (!instrument || !target) continue;
      model.signals.push({ instrument, kind: s.kind, target });
    }
    model.ambiguities.push(...reply.ambiguities);
  }

  // a component claimed by two runs: keep it on the first, note the conflict
  const owner = new Map<string, string>();
  for (const l of model.lines) {
    l.components = l.components.filter((c) => {
      const o = owner.get(c);
      if (o) {
        model.ambiguities.push({ tag: c, issue: `Placed on both ${o} and ${l.id}; kept on ${o}. Check which pipe it sits on.` });
        return false;
      }
      owner.set(c, l.id);
      return true;
    });
  }
  // fill line_ref on components from their run
  for (const l of model.lines) for (const c of l.components) {
    const it = model.items.find((i) => i.id === c);
    if (it && !it.line_ref) it.line_ref = l.line_id ?? l.id;
  }
  enrichInstruments(model.items);
  if (netsByPage.size) {
    const ends = closeOpenEnds(model, netsByPage);
    const strays = placeOrphans(model, netsByPage);
    const joined = joinDrawnPipes(model, netsByPage);
    if (joined.length) {
      ctx.log("connect", `vector layer added ${joined.length} drawn pipes the runs left out: ${joined.join("; ")}`);
      model.comments.push(`vector layer: pipes added from the drawn lines (no traced run): ${joined.join("; ")}`);
    }
    const links = linkByNets(model, netsByPage);
    const agree = netAgreement(model, netsByPage);
    if (ends.length) ctx.log("connect", `vector layer closed ${ends.length} open run ends: ${ends.join("; ")}`);
    if (strays.length) {
      ctx.log("connect", `vector layer placed ${strays.length} components that were on no run: ${strays.join("; ")}`);
      model.comments.push(`vector layer: placed from the drawn lines (no traced run): ${strays.join("; ")}`);
    }
    if (links.length) ctx.log("connect", `vector layer linked ${links.length} instruments: ${links.join("; ")}`);
    if (agree.pairs) {
      ctx.log("connect", `runs agree with the drawn lines for ${agree.ok}/${agree.pairs} neighbour pairs (${agree.share})`);
      model.comments.push(`vector check: ${agree.ok}/${agree.pairs} neighbour pairs on traced runs are joined by a drawn line`);
    }
  }
  // dashed signal lines are too thin for the whole-sheet view: follow them on zoomed crops
  if (ctx.settings.depth !== "fast") await linkInstruments(ctx, model, system);
  if (netsByPage.size) {
    // drawn signal lines and exact pipe routes (nets again: tracing may have added symbols)
    const nets = computeNets(ctx, model, pages);
    const g = applyGeometry(model, nets);
    ctx.log("connect", `vector layer: ${g.signalLines} drawn signal lines (${g.carried} links carried by one), ${g.routes} exact pipe routes, ${g.taps} tap points`);
    const named = nozzleLabels(ctx, model, pages, nets);
    if (named.length) ctx.log("connect", `vector layer: ${named.length} run ends take the nozzle name printed there: ${named.join(", ")}`);
  }
  ctx.writeJSON("drawing.model.json", model);
  writeDrawingXml(ctx, model, "drawing.verified.xml");
  ctx.log("connect", `${model.lines.length} runs, ${model.signals.length} instrument links, ${owner.size} components placed on runs, ${added} symbols added while tracing`);
}

function readTokens(ctx: RunContext): Token[] {
  try {
    return JSON.parse(fs.readFileSync(ctx.path("work", "ocr_tokens.json"), "utf8"));
  } catch {
    return [];
  }
}

/** Item for a symbol the tracer added: box of a typical item of its kind around the given centre, snapped to its printed tag. */
function newItem(n: NewItem, page: PageImage, items: Item[], tokens: Token[]): Item {
  let x = ((n.at?.[0] ?? 500) / 1000) * page.W;
  let y = ((n.at?.[1] ?? 500) / 1000) * page.H;
  const nt = normTag(n.tag);
  if (nt) {
    const near = tokens
      .filter((t) => t.page === page.n && t.norm === nt)
      .map((t) => ({ t, d: Math.hypot(center(t.box)[0] - x, center(t.box)[1] - y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 0.04 * Math.hypot(page.W, page.H)) [x, y] = center(near.t.box);
  }
  const kin = items.filter((i) => i.category === n.category).map((i) => Math.max(i.bbox[2] - i.bbox[0], i.bbox[3] - i.bbox[1])).sort((a, b) => a - b);
  const side = kin.length ? kin[Math.floor(kin.length / 2)] : 0.015 * Math.max(page.W, page.H);
  return {
    id: "",
    page: page.n,
    tag: n.tag,
    category: n.category,
    type: n.type,
    dexpi_class: n.dexpi_class,
    description: n.description,
    service: null,
    size: null,
    line_ref: null,
    actuator: null,
    loop: null,
    color: null,
    bbox: [x - side / 2, y - side / 2, x + side / 2, y + side / 2].map(Math.round) as BBox,
    confidence: 0.5,
    sources: [`connect-p${page.n}`],
    note: `added while tracing the piping: ${n.reason}`,
  };
}
