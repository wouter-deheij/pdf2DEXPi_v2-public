import { callJSON, stepUp } from "../llm.ts";
import { FatalApiError } from "../llm.ts";
import type { Category, DrawingModel, Item } from "../types.ts";
import type { RunContext } from "./context.ts";
import { backProject, blocks, cropForModel, inside, toRegion, type Region } from "./images.ts";
import type { PageImage } from "./locate.ts";
import { assignIds, family, normTag, repeatsOnSheet } from "./merge.ts";
import { enrichInstruments } from "./digitize.ts";
import { AUDIT_SCHEMA, DEXPI_PIPING, systemPrompt } from "./prompts.ts";
import { writeDrawingXml } from "./xml.ts";
import { anchorItems, setOcrOpenPoints, type Token } from "./ocr.ts";
import { ambiguityOf, recheckFindings, type Deferred } from "./recheck.ts";

export interface Finding {
  kind: "missing" | "hallucinated" | "wrong_tag" | "wrong_type" | "wrong_attribute" | "duplicate" | "wrong_category" | "wrong_position";
  item_id: string | null;
  proposed: (Omit<Item, "id" | "page" | "loop" | "sources" | "bbox"> & { bbox: number[] }) | null;
  confidence: number;
  issue: string;
}
interface AuditReply {
  score: number;
  findings: Finding[];
}

/** Audit region grid per page: about 1500–2000 page px per block so small text stays legible. */
export function auditBlocks(p: { n: number; W: number; H: number }): Region[] {
  const cols = Math.max(2, Math.round(p.W / 1900));
  const rows = Math.max(2, Math.round(p.H / 1900));
  return blocks(p.n, p.W, p.H, cols, rows, 0.08, "a");
}

export async function verify(ctx: RunContext) {
  const model = ctx.bag.model as DrawingModel;
  const pages = ctx.bag.pages as PageImage[];
  const depth = ctx.settings.depth;

  if (depth === "fast") {
    const score = model.items.length ? model.items.reduce((s, i) => s + i.confidence, 0) / model.items.length : 0;
    ctx.bag.score = Number(score.toFixed(2));
    model.comments.push(`depth=fast: no audit ran; score is the merge's own mean confidence (${score.toFixed(2)})`);
    ctx.log("verify", `depth=fast — no audit ran; score = mean merge confidence ${score.toFixed(2)}`);
    finish(ctx, model);
    return;
  }

  const maxRounds = depth === "exhaustive" ? 4 : 1;
  let last = -1;
  for (let round = 1; round <= maxRounds; round++) {
    const score = await auditRound(ctx, model, pages, round);
    ctx.log("verify", `round ${round}: score ${score.toFixed(2)}`);
    ctx.bag.score = Number(score.toFixed(2));
    if (depth === "exhaustive" && last >= 0 && score - last < 0.02) {
      ctx.log("verify", `improvement ${(score - last).toFixed(3)} < 0.02 — stopping`);
      break;
    }
    last = score;
  }
  finish(ctx, model);
}

/**
 * Consistency rules after the audit (its classification drifts from run to run):
 *  - vessel nozzles, sight glasses, manholes, spray balls, spargers are piping components, not equipment;
 *  - a motor/drive lying mostly inside a larger agitator is part of that agitator.
 */
export function tidyEquipment(model: DrawingModel) {
  const notes: string[] = [];
  for (const i of model.items) {
    if (i.category === "equipment" && /nozzle|sight_?glass|manhole|spray_?ball|sparger|lamp|light/.test(i.type)) {
      i.category = "piping_component";
      if (i.dexpi_class && !(DEXPI_PIPING as readonly string[]).includes(i.dexpi_class)) i.dexpi_class = null;
      notes.push(`${i.tag ?? i.id} (${i.type}) → piping component`);
    }
  }
  const ar = (b: number[]) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  const ov = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const agit = model.items.filter((i) => i.category === "equipment" && family(i.type) === "agitator");
  const gone = new Map<string, string>();
  for (const part of agit) {
    const host = agit.find((h) => h !== part && !gone.has(h.id) && ar(h.bbox) > ar(part.bbox) && ov(part.bbox, h.bbox) > 0.5 * ar(part.bbox));
    if (!host) continue;
    gone.set(part.id, host.id);
    host.sources.push(...part.sources);
    if (!host.tag && part.tag && !/^M$/i.test(part.tag)) host.tag = part.tag;
    host.note = [host.note, `includes ${part.tag ?? part.id} (${part.type})`].filter(Boolean).join("; ");
    notes.push(`${part.tag ?? part.id} (${part.type}) folded into agitator ${host.id}`);
  }
  if (gone.size) {
    model.items = model.items.filter((i) => !gone.has(i.id));
    for (const l of model.lines) for (const e of [l.from, l.to]) if (e.ref && gone.has(e.ref)) e.ref = gone.get(e.ref)!;
    for (const sg of model.signals) if (gone.has(sg.target)) sg.target = gone.get(sg.target)!;
  }
  return notes;
}

function finish(ctx: RunContext, model: DrawingModel) {
  const tidy = tidyEquipment(model);
  if (tidy.length) ctx.log("verify", `tidy: ${tidy.join("; ")}`);
  const tokens = (ctx.bag.ocrTokens as Token[]) ?? [];
  if (tokens.length) {
    const a = anchorItems(model, tokens);
    setOcrOpenPoints(model, a.unlisted);
    ctx.log("verify", `OCR re-anchor: ${a.matched} tags located, ${a.moved} boxes moved, ${a.removed} repeated readings removed, ${a.unlisted.length} unlisted printed tags → open points`);
  }
  model.comments.push(`verified pass: audit score ${ctx.bag.score}`);
  ctx.writeJSON("drawing.model.json", model);
  writeDrawingXml(ctx, model, "drawing.verified.xml");
}

async function auditRound(ctx: RunContext, model: DrawingModel, pages: PageImage[], round: number) {
  const system = systemPrompt(ctx.settings, model.standard);
  const regions = pages.flatMap((p) => auditBlocks(p).map((r) => ({ r, p })));
  ctx.log("verify", `audit round ${round}: ${regions.length} regions`);

  const results = await Promise.all(
    regions.map(async ({ r, p }) => {
      const img = await cropForModel(p.file, r);
      const local = model.items.filter((i) => i.page === p.n && inside(i.bbox, r));
      const list = local
        .map((i) => `${i.id}\t${i.category}\t${i.type}\ttag=${i.tag ?? "—"}${i.dexpi_class ? `\tclass=${i.dexpi_class}` : ""}\tbox=${JSON.stringify(toRegion(i.bbox, r))}`)
        .join("\n");
      try {
        const reply = await callJSON<AuditReply>(ctx, {
          stage: "verify",
          label: `audit ${r.id} (round ${round})`,
          system,
          prompt: `Audit this region of a P&ID sheet against the item list a first pass produced for it (boxes are 0–1000 relative to this image):
${list || "(no items listed for this region)"}

Be exhaustive and skeptical. Report every:
- missing: a symbol visible here that is not in the list (give 'proposed' with its bbox in this image);
- hallucinated: a listed item that is not on the drawing;
- wrong_tag / wrong_type / wrong_category / wrong_attribute: a listed item that is read wrongly (give the corrected item in 'proposed');
- duplicate: a listed item that is the same symbol as another listed item (item_id = the one to drop);
- wrong_position: a listed item whose box does not sit on its symbol (give 'proposed' with the correct box; for an instrument the box is the bubble, for a valve the valve body).
Items cut off at the image border can belong to the neighbouring region — do not call them missing or hallucinated unless you are sure.
Ignore title block, legend, revision table and notes. score = how complete and correct the list is for this region (1 = perfect).`,
          images: [{ data: img.data, mediaType: "image/png" }],
          schema: AUDIT_SCHEMA,
          effort: stepUp(ctx.settings.effort),
        });
        ctx.writeJSON(`work/audit_r${round}_${r.id}.json`, reply);
        return { r, local: local.length, reply };
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        ctx.log("verify", `audit ${r.id} failed: ${(e as Error).message}`);
        return { r, local: local.length, reply: null };
      }
    }),
  );

  let applied = 0, commented = 0;
  const removed = new Set<string>();
  const uncertain: Deferred[] = [];
  for (const { r, reply } of results) {
    if (!reply) continue;
    for (const f of reply.findings) {
      // low confidence: a second, zoomed look decides (below)
      if (f.confidence < 0.6) uncertain.push({ f, r });
      else if (applyFinding(model, f, r, `audit-r${round}:${r.id}`, `audit r${round}`, removed)) applied++;
      else commented++;
    }
  }
  const rc = await recheckFindings(ctx, model, uncertain, system);
  for (const c of rc.confirmed) applyFinding(model, c.f, c.r, `recheck-r${round}`, `audit r${round}, confirmed on a zoomed look`, removed);
  for (const u of rc.unsure) model.ambiguities.push(ambiguityOf(u));
  if (rc.rejected.length) model.comments.push(`recheck r${round}: ${rc.rejected.length} uncertain audit findings rejected on a zoomed look`);
  const deferred = rc.unsure.length;
  ctx.log("verify", `recheck: ${uncertain.length} uncertain findings → ${rc.confirmed.length} confirmed, ${rc.rejected.length} rejected, ${rc.unsure.length} still open`);
  settle(model, removed);

  ctx.log("verify", `round ${round}: ${applied} fixes applied, ${commented} applied with comment, ${deferred} left as ambiguities, ${removed.size} removed`);
  const weighted = results.filter((x) => x.reply);
  const wsum = weighted.reduce((s, x) => s + Math.max(1, x.local), 0);
  return wsum ? weighted.reduce((s, x) => s + x.reply!.score * Math.max(1, x.local), 0) / wsum : 0;
}

/**
 * Apply one audit finding to the model. `source` is recorded on the item, `label` in its note.
 * Returns true when applied without a comment (confidence ≥ 0.85).
 */
export function applyFinding(model: DrawingModel, f: Finding, r: Region, source: string, label: string, removed: Set<string>) {
  const note = f.confidence < 0.85 ? `${label}: ${f.kind} — ${f.issue} (conf ${f.confidence.toFixed(2)})` : undefined;
  const target = f.item_id ? model.items.find((i) => i.id === f.item_id) : undefined;
  switch (f.kind) {
    case "missing": {
      if (!f.proposed) break;
      const nt = normTag(f.proposed.tag);
      // already known elsewhere (a letters-only tag such as TT is printed many times: only at this spot)
      if (nt && model.items.some((i) => i.page === r.page && normTag(i.tag) === nt && (!repeatsOnSheet(nt, f.proposed!.category) || sameSpot(i.bbox, backProject(f.proposed!.bbox, r))))) break;
      // untagged equipment already listed (e.g. seen again from the neighbouring audit region):
      // the same kind of thing overlapping it is the same item — grow the box instead of adding it
      if (!nt && f.proposed.category === "equipment") {
        const box = backProject(f.proposed.bbox, r);
        const ov = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
        const ar = (a: number[]) => Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
        const twin = model.items.find((i) => i.page === r.page && i.category === "equipment" && !normTag(i.tag) && family(i.type) === family(f.proposed!.type) && ov(i.bbox, box) > 0.2 * Math.min(ar(i.bbox), ar(box)));
        if (twin) {
          twin.sources.push(source);
          break;
        }
      }
      model.items.push({
        id: "",
        page: r.page,
        tag: f.proposed.tag,
        category: f.proposed.category as Category,
        type: f.proposed.type,
        dexpi_class: f.proposed.dexpi_class,
        description: f.proposed.description,
        service: f.proposed.service,
        size: f.proposed.size,
        line_ref: f.proposed.line_ref,
        actuator: f.proposed.actuator,
        loop: null,
        color: f.proposed.color,
        bbox: backProject(f.proposed.bbox, r),
        confidence: Number(Math.min(f.proposed.confidence, f.confidence).toFixed(2)),
        sources: [source],
        note: note ?? `added by ${label}`,
      });
      break;
    }
    case "hallucinated":
    case "duplicate":
      if (target) removed.add(target.id);
      break;
    default:
      if (target && f.proposed) {
        const before = `${target.tag ?? "—"}/${target.type}`;
        Object.assign(target, {
          tag: f.proposed.tag ?? target.tag,
          category: f.proposed.category ?? target.category,
          type: f.proposed.type ?? target.type,
          dexpi_class: f.proposed.dexpi_class ?? target.dexpi_class,
          description: f.proposed.description ?? target.description,
          service: f.proposed.service ?? target.service,
          size: f.proposed.size ?? target.size,
          actuator: f.proposed.actuator ?? target.actuator,
        });
        if (f.kind === "wrong_position" && f.proposed.bbox?.length === 4) target.bbox = backProject(f.proposed.bbox, r);
        target.sources.push(source);
        target.note = [target.note, note ?? `${label}: ${before} → ${target.tag ?? "—"}/${target.type}`].filter(Boolean).join("; ");
      }
  }
  return !note;
}

/**
 * After findings were applied: drop removed items and their references (also on pipe runs,
 * when the connect stage already ran), give new items ids, merge items that now share a tag.
 */
/** Two boxes on the same symbol: centres closer than the larger box's size. */
function sameSpot(a: number[], b: number[]) {
  const size = Math.max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1], 20);
  return Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) < size;
}

export function settle(model: DrawingModel, removed: Set<string>) {
  const redirect = (from: string, to: string | null) => {
    for (const l of model.lines) {
      l.components = to ? l.components.map((c) => (c === from ? to : c)).filter((c, k, a) => a.indexOf(c) === k) : l.components.filter((c) => c !== from);
      for (const e of [l.from, l.to]) {
        if (e.after === from) e.after = to;
        if (e.kind !== "line" && e.ref === from) {
          e.ref = to;
          if (!to) e.kind = "open";
        }
      }
    }
    model.signals = to ? model.signals.map((s) => ({ ...s, instrument: s.instrument === from ? to : s.instrument, target: s.target === from ? to : s.target })) : model.signals.filter((s) => s.instrument !== from && s.target !== from);
  };
  if (removed.size) {
    model.items = model.items.filter((i) => !removed.has(i.id));
    for (const id of removed) redirect(id, null);
  }
  // regenerate ids the same way the first pass did (keeping existing ids stable)
  const fresh = model.items.filter((i) => !i.id);
  if (fresh.length) {
    const taken = new Set(model.items.filter((i) => i.id).map((i) => i.id));
    assignIds(fresh);
    for (const f of fresh) {
      let id = f.id;
      for (let n = 2; taken.has(id); n++) id = `${f.id}_${n}`;
      f.id = id;
      taken.add(id);
    }
  }
  // merge items that now share a tag (e.g. after wrong_tag fixes)
  const seen = new Map<string, Item>();
  const merged: [string, string][] = [];
  const spots = new Map<string, Item[]>(); // letters-only tags: one entry per printed bubble
  model.items = model.items.filter((i) => {
    const k = normTag(i.tag);
    if (!k) return true;
    const key = `${i.page}|${k}`;
    let o = seen.get(key);
    if (repeatsOnSheet(k, i.category)) {
      o = spots.get(key)?.find((x) => x.category === i.category && sameSpot(x.bbox, i.bbox));
      if (!o) spots.set(key, [...(spots.get(key) ?? []), i]);
    }
    if (o) {
      o.sources.push(...i.sources);
      o.confidence = Math.max(o.confidence, i.confidence);
      merged.push([i.id, o.id]);
      return false;
    }
    seen.set(key, i);
    return true;
  });
  for (const [from, to] of merged) redirect(from, to);
  enrichInstruments(model.items);
}
