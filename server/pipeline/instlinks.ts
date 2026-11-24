import sharp from "sharp";
import { callJSON } from "../llm.ts";
import { FatalApiError } from "../llm.ts";
import type { BBox, DrawingModel, Item, SignalLink } from "../types.ts";
import type { RunContext } from "./context.ts";
import { center, cropForModel, type Region } from "./images.ts";
import { splitInstrumentTag } from "./merge.ts";

/**
 * Instrument links on a zoomed crop.
 *
 * The topology pass sees the whole sheet at about a third of its resolution: pipes survive,
 * thin dashed signal lines from a bubble to its pipe, vessel, valve or motor often do not.
 * Every instrument that has no path to a process object (directly, or through the instruments
 * it signals) is looked at again on a ~1200 px crop around it, with the bubbles in question
 * outlined and the nearby items and runs listed, and the model follows its lines.
 */

type Edge = "top" | "bottom" | "left" | "right";
interface Exit {
  edge: Edge;
  at: number;
}
interface LinkReply {
  instruments: { id: string; links: SignalLink[]; leaves: Exit | null; note: string | null }[];
}

const LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["instruments"],
  properties: {
    instruments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "links", "leaves", "note"],
        properties: {
          id: { type: "string", description: "Id of an outlined instrument" },
          links: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["instrument", "kind", "target"],
              properties: {
                instrument: { type: "string" },
                kind: { type: "string", enum: ["measures", "actuates", "signal"] },
                target: { type: "string", description: "Item id or run id from the lists" },
              },
            },
          },
          leaves: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["edge", "at"],
                properties: {
                  edge: { type: "string", enum: ["top", "bottom", "left", "right"] },
                  at: { type: "number", description: "Where along that edge the line crosses it, 0–1000 (x for top/bottom, y for left/right)" },
                },
              },
            ],
            description: "Its line runs out of the image before reaching anything: where it leaves. Null when it ends inside the image.",
          },
          note: { type: ["string", "null"], description: "Only when its line cannot be followed: one sentence why" },
        },
      },
    },
  },
};

const PROCESS = new Set(["equipment", "valve", "piping_component"]);

/** Instruments whose signal graph never reaches a run, equipment, valve or piping component. */
export function unanchoredInstruments(model: DrawingModel) {
  const cat = new Map(model.items.map((i) => [i.id, i.category]));
  const lineIds = new Set(model.lines.map((l) => l.id));
  const ins = model.items.filter((i) => i.category === "instrument");
  const adj = new Map(ins.map((i) => [i.id, new Set<string>()]));
  const anchored = new Set<string>();
  for (const s of model.signals) {
    const tc = cat.get(s.target);
    if (tc === "instrument") {
      adj.get(s.instrument)?.add(s.target);
      adj.get(s.target)?.add(s.instrument);
    } else if (lineIds.has(s.target) || (tc && PROCESS.has(tc))) anchored.add(s.instrument);
  }
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const i of ins) {
    if (seen.has(i.id)) continue;
    const comp: string[] = [];
    const st = [i.id];
    while (st.length) {
      const x = st.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      comp.push(x);
      st.push(...(adj.get(x) ?? []));
    }
    if (!comp.some((c) => anchored.has(c))) out.push(...ins.filter((x) => comp.includes(x.id)));
  }
  return out;
}

export async function linkInstruments(ctx: RunContext, model: DrawingModel, system: string) {
  const todo = unanchoredInstruments(model);
  if (!todo.length) return { asked: 0, linked: 0, links: 0 };
  const pageFile = (n: number) => ctx.path("pages", `page-${n}.png`);
  const SIDE = 1200;

  // group nearby instruments into one crop each
  const groups: { page: number; items: Item[]; region: Region }[] = [];
  const left = [...todo];
  while (left.length) {
    const seed = left.shift()!;
    const page = model.pages.find((p) => p.n === seed.page)!;
    const [W, H] = page.px;
    const [sx, sy] = center(seed.bbox);
    const x = Math.round(Math.min(Math.max(0, sx - SIDE / 2), Math.max(0, W - SIDE)));
    const y = Math.round(Math.min(Math.max(0, sy - SIDE / 2), Math.max(0, H - SIDE)));
    const region: Region = { id: `il${groups.length + 1}`, page: seed.page, x, y, w: Math.min(SIDE, W - x), h: Math.min(SIDE, H - y) };
    // members: well inside the crop, so their lines have room to be followed
    const inner = (b: BBox) => {
      const [cx, cy] = center(b);
      return cx > x + 0.2 * region.w && cx < x + 0.8 * region.w && cy > y + 0.2 * region.h && cy < y + 0.8 * region.h;
    };
    const members = [seed, ...left.filter((i) => i.page === seed.page && inner(i.bbox))].slice(0, 12);
    for (const m of members) left.splice(left.indexOf(m), 1);
    groups.push({ page: seed.page, items: members, region });
  }

  const lineOf = new Map<string, string>();
  for (const l of model.lines) for (const c of l.components) lineOf.set(c, l.id);
  let linked = 0, links = 0, crops = 0;
  const byId = new Map(model.items.map((i) => [i.id, i]));

  /** One crop, one question. `entry`: a line coming in from the previous crop (follow step). */
  const ask = async (r: Region, ids: string[], entry: { edge: Edge; at: number; step: number } | null) => {
    crops++;
    const mine = ids.map((id) => byId.get(id)!).filter(Boolean);
    const img = await cropForModel(pageFile(r.page), r, 1200);
    const s = img.scale;
    const rel = (b: BBox) => {
      const [cx, cy] = center(b);
      return `(${Math.round(((cx - r.x) / r.w) * 1000)},${Math.round(((cy - r.y) / r.h) * 1000)})`;
    };
    const within = (b: BBox) => b[2] > r.x && b[0] < r.x + r.w && b[3] > r.y && b[1] < r.y + r.h;
    const nearby = model.items.filter((i) => i.page === r.page && within(i.bbox));
    // runs that pass through the crop: their components or end items lie in it
    const runs = model.lines.filter((l) => l.page === r.page && [...l.components, l.from.ref, l.to.ref].some((c) => c && nearby.some((i) => i.id === c)));
    const iw = Math.round(r.w * s), ih = Math.round(r.h * s);
    let marks = mine
      .filter((i) => within(i.bbox))
      .map((i) => {
        const [a0, b0, a1, b1] = [(i.bbox[0] - r.x) * s, (i.bbox[1] - r.y) * s, (i.bbox[2] - r.x) * s, (i.bbox[3] - r.y) * s].map(Math.round);
        return `<rect x="${a0 - 4}" y="${b0 - 4}" width="${a1 - a0 + 8}" height="${b1 - b0 + 8}" fill="none" stroke="#e0109a" stroke-width="3" stroke-dasharray="10 6"/>`;
      })
      .join("");
    if (entry) {
      // where the followed line enters: a magenta ring on that edge
      const ex = entry.edge === "left" ? 0 : entry.edge === "right" ? iw : (entry.at / 1000) * iw;
      const ey = entry.edge === "top" ? 0 : entry.edge === "bottom" ? ih : (entry.at / 1000) * ih;
      marks += `<circle cx="${Math.round(ex)}" cy="${Math.round(ey)}" r="22" fill="none" stroke="#e0109a" stroke-width="4"/>`;
    }
    const data = await sharp(img.data).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}">${marks}</svg>`) }]).png().toBuffer();
    const head = entry
      ? `Zoomed crop of a P&ID sheet, continuing a line. The signal line(s) of these instruments left the previous crop and enter THIS crop at its ${entry.edge} edge at about ${Math.round(entry.at)}/1000 (magenta ring):
${mine.map((i) => `${i.id}\ttag=${i.tag ?? "—"}\t${i.description ?? i.type}`).join("\n")}
Follow that line from the ring onward to where it ends.`
      : `Zoomed crop of a P&ID sheet. The instrument bubbles outlined in magenta have no connection to the process yet:
${mine.map((i) => `${i.id}\ttag=${i.tag ?? "—"}\t${i.description ?? i.type}\tat ${rel(i.bbox)}`).join("\n")}
For each, follow the lines that leave its bubble — dashed or dotted signal lines, solid process/impulse lines, a sensing element drawn on a pipe or in a vessel — to where they end.`;
    const prompt = `${head}

Items in this crop (id, category, type, tag, position on a 0–1000 grid of this image):
${nearby.filter((i) => !ids.includes(i.id)).map((i) => `${i.id}\t${i.category}\t${i.type}${i.tag ? `\ttag=${i.tag}` : ""}\tat ${rel(i.bbox)}${lineOf.has(i.id) ? `\ton run ${lineOf.get(i.id)}` : ""}`).join("\n") || "(none)"}

Pipe runs passing through this crop: ${runs.map((l) => `${l.id}${l.service ? ` (${l.service})` : ""}`).join(", ") || "(none)"}

Report per instrument (one entry for each id above):
- measures: the run (run id) or equipment it senses; for a sensor on a pipe use the run the pipe belongs to;
- actuates: the valve, motor/agitator, pump or other equipment it drives;
- signal: another instrument it exchanges a signal with.
Use only ids from the lists. Where a line joins a bus or junction, follow the branch that belongs to this instrument (same loop number, nearest branch). If its line runs out of this image before reaching anything, give 'leaves' (edge + position) so the next crop can follow it. Return JSON only.`;
    try {
      const reply = await callJSON<LinkReply>(ctx, {
        stage: "connect",
        label: `instrument links ${r.id}${entry ? ` (follow ${entry.step})` : ""} (${mine.length})`,
        system,
        prompt,
        images: [{ data, mediaType: "image/png" }],
        schema: LINK_SCHEMA,
        effort: ctx.settings.effort,
        maxTokens: 16000,
      });
      ctx.writeJSON(`work/instlinks_${r.id}.json`, { region: r, asked: ids, entry, reply });
      ctx.writeText(`work/instlinks_${r.id}.png`, data);
      const ok = new Set([...nearby.map((i) => i.id), ...runs.map((l) => l.id)]);
      const exits: { id: string; leaves: Exit }[] = [];
      for (const e of reply.instruments) {
        if (!ids.includes(e.id)) continue;
        let n = 0;
        for (const l of e.links) {
          const target = ok.has(l.target) ? l.target : lineOf.has(l.target) && l.kind === "measures" ? lineOf.get(l.target)! : null;
          if (!target || target === e.id) continue;
          if (model.signals.some((x) => x.instrument === e.id && x.target === target && x.kind === l.kind)) continue;
          model.signals.push({ instrument: e.id, kind: l.kind, target });
          n++;
        }
        if (n) linked++;
        links += n;
        if (!n && e.leaves) exits.push({ id: e.id, leaves: e.leaves });
      }
      return exits;
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      ctx.log("connect", `instrument links ${r.id} failed: ${(e as Error).message}`);
      return [];
    }
  };

  /** The crop beyond `edge` of r, centred on where the line crosses it. */
  const beyond = (r: Region, x: Exit, k: number): Region | null => {
    const page = model.pages.find((p) => p.n === r.page)!;
    const [W, H] = page.px;
    const px = r.x + (x.edge === "left" ? 0 : x.edge === "right" ? r.w : (x.at / 1000) * r.w);
    const py = r.y + (x.edge === "top" ? 0 : x.edge === "bottom" ? r.h : (x.at / 1000) * r.h);
    if ((x.edge === "left" && px <= 1) || (x.edge === "top" && py <= 1) || (x.edge === "right" && px >= W - 1) || (x.edge === "bottom" && py >= H - 1)) return null; // sheet edge
    const ov = 0.05 * SIDE;
    let nx = x.edge === "left" ? px - SIDE + ov : x.edge === "right" ? px - ov : px - SIDE / 2;
    let ny = x.edge === "top" ? py - SIDE + ov : x.edge === "bottom" ? py - ov : py - SIDE / 2;
    nx = Math.round(Math.min(Math.max(0, nx), Math.max(0, W - SIDE)));
    ny = Math.round(Math.min(Math.max(0, ny), Math.max(0, H - SIDE)));
    return { id: `${r.id}_${k}`, page: r.page, x: nx, y: ny, w: Math.min(SIDE, W - nx), h: Math.min(SIDE, H - ny) };
  };
  const entryOf = (from: Region, to: Region, x: Exit) => {
    const px = from.x + (x.edge === "left" ? 0 : x.edge === "right" ? from.w : (x.at / 1000) * from.w);
    const py = from.y + (x.edge === "top" ? 0 : x.edge === "bottom" ? from.h : (x.at / 1000) * from.h);
    const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
    const edge = opposite[x.edge];
    const at = edge === "top" || edge === "bottom" ? ((px - to.x) / to.w) * 1000 : ((py - to.y) / to.h) * 1000;
    return { edge, at: Math.min(1000, Math.max(0, at)) };
  };

  await Promise.all(
    groups.map(async (g) => {
      let pending = (await ask(g.region, g.items.map((i) => i.id), null)).map((e) => ({ ...e, region: g.region }));
      // follow lines that run out of the crop, up to 4 crops further; lines leaving together (a bus) share one crop
      for (let step = 1; step <= 4 && pending.length; step++) {
        const bundles = new Map<string, typeof pending>();
        for (const e of pending) {
          const key = `${e.region.id}|${e.leaves.edge}|${Math.round(e.leaves.at / 60)}`;
          bundles.set(key, [...(bundles.get(key) ?? []), e]);
        }
        const next: typeof pending = [];
        let k = 0;
        for (const b of bundles.values()) {
          const from = b[0].region;
          const to = beyond(from, b[0].leaves, ++k);
          if (!to) continue;
          const entry = { ...entryOf(from, to, b[0].leaves), step };
          const exits = await ask(to, b.map((e) => e.id), entry);
          next.push(...exits.map((e) => ({ ...e, region: to })));
        }
        pending = next;
      }
    }),
  );
  const byLoop = linkByLoop(model);
  if (byLoop.length) {
    model.comments.push(`instrument links from the loop number (signal lines ran into a shared bus): ${byLoop.join(", ")}`);
    links += byLoop.length;
  }
  const loose = linkLooseByLoop(model);
  if (loose.length) {
    model.comments.push(`instrument links inferred from the loop number (no drawn line): ${loose.join(", ")}`);
    links += loose.length;
  }
  const still = unanchoredInstruments(model);
  if (still.length) model.ambiguities.push({ tag: still.map((i) => i.tag ?? i.id).join(", "), issue: "No line from these instruments to a pipe, vessel, valve or motor could be followed on the zoomed crop; link them by hand." });
  ctx.log("connect", `instrument links: ${todo.length} instruments without a path to the process, ${crops} crops (${groups.length} groups) → ${links} links added; ${still.length} still unlinked`);
  return { asked: todo.length, linked, links, still: still.length };
}

/**
 * Last resort for instruments whose signal line runs into a shared bus (RTU/DCS I/O drawn as
 * a row of bubbles): ISA tags with the same loop number belong to one loop. Link such an
 * instrument to the loop member that reaches the process — the one driving the final element
 * first, else the one measuring. Only for specific loop numbers (4+ digits, e.g. 6902) or a
 * member with the same measured variable; a short number like 001 is shared by many loops.
 * Returns "ZCO6902 → FV6902"-style notes.
 */
export function linkByLoop(model: DrawingModel) {
  const notes: string[] = [];
  const cat = new Map(model.items.map((i) => [i.id, i.category]));
  const lineIds = new Set(model.lines.map((l) => l.id));
  const direct = (id: string, kind: "actuates" | "measures") =>
    model.signals.some((s) => s.instrument === id && s.kind === kind && (lineIds.has(s.target) || PROCESS.has(cat.get(s.target) ?? "")));
  for (const it of unanchoredInstruments(model)) {
    if (!it.loop) continue;
    const mates = model.items.filter((o) => o !== it && o.category === "instrument" && o.page === it.page && o.loop === it.loop);
    const variable = (x: Item) => (x.tag ?? "").replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase();
    // a sensing instrument (element, transmitter, indicator, alarm) joins the measuring member of
    // the same measured variable only (a level element never hangs off a pressure gauge);
    // a switch / controller / command the member that drives the final element
    const fn = splitInstrumentTag(it.tag).functions;
    const sensing = /^[ETIGRAL]*$/.test(fn) && fn.length > 0;
    const allowed = it.loop.replace(/\D/g, "").length >= 4 && !sensing ? mates : mates.filter((o) => variable(o) === variable(it));
    const order: ("measures" | "actuates")[] = sensing ? ["measures", "actuates"] : ["actuates", "measures"];
    const target = allowed.find((o) => direct(o.id, order[0])) ?? allowed.find((o) => direct(o.id, order[1]));
    if (!target) continue;
    model.signals.push({ instrument: it.id, kind: "signal", target: target.id, basis: "loop" });
    notes.push(`${it.tag ?? it.id} → ${target.tag ?? target.id}`);
  }
  return notes;
}

/**
 * Bubbles with no link at all and no drawn line (a panel group printed next to the process):
 * join them to a member of their loop with the same measured variable — the one that reaches the
 * process if there is one, else any linked member, else any member. Inferred, marked basis "loop".
 */
export function linkLooseByLoop(model: DrawingModel) {
  const notes: string[] = [];
  const touched = () => new Set(model.signals.flatMap((s) => [s.instrument, s.target]));
  const cat = new Map(model.items.map((i) => [i.id, i.category]));
  const lineIds = new Set(model.lines.map((l) => l.id));
  const anchored = (id: string) => model.signals.some((s) => s.instrument === id && (lineIds.has(s.target) || PROCESS.has(cat.get(s.target) ?? "")));
  const variable = (x: Item) => splitInstrumentTag(x.tag).letters.slice(0, 1).toUpperCase();
  for (const it of model.items) {
    if (it.category !== "instrument" || !it.loop || touched().has(it.id)) continue;
    const mates = model.items.filter((o) => o !== it && o.category === "instrument" && o.page === it.page && o.loop === it.loop && variable(o) === variable(it));
    const linked = touched();
    const target = mates.find((o) => anchored(o.id)) ?? mates.find((o) => linked.has(o.id)) ?? mates[0];
    if (!target) continue;
    model.signals.push({ instrument: it.id, kind: "signal", target: target.id, basis: "loop" });
    notes.push(`${it.tag ?? it.id} → ${target.tag ?? target.id}`);
  }
  return notes;
}
