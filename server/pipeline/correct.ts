import fs from "node:fs";
import path from "node:path";
import { callJSON, stepUp, FatalApiError } from "../llm.ts";
import type { Ambiguity, BBox, DrawingModel, Endpoint, Item, Line } from "../types.ts";
import type { RunContext } from "./context.ts";
import { cropForModel, inside, toRegion, type Region } from "./images.ts";
import type { PageImage } from "./locate.ts";
import { normTag } from "./merge.ts";
import { AUDIT_SCHEMA, endpoint, systemPrompt } from "./prompts.ts";
import { applyFinding, settle, type Finding } from "./verify.ts";

/**
 * Correction run: keep the reading of an earlier run and look again, zoomed in, only where checking it
 * found something: its open points, where its drawing does not lie on the PDF (overlay), and the items
 * the engineer's notes name. The model corrects items and pipe runs there and says per point whether it
 * is resolved, was right, or is still open; everything else stays exactly as it was.
 */

export interface Issue {
  kind: "open_point" | "missed" | "invented" | "note";
  text: string;
  items: string[];
  ambiguity?: Ambiguity;
}

const readJSON = <T,>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const MIN_PX = 150, MAX_OVERLAY = 15, MAX_REGIONS = 10;

/** The points a correction looks at, each tied to the items it is about. */
export function correctionIssues(dir: string, model: DrawingModel, notes: string): { issues: Issue[]; unplaced: string[] } {
  const ov = readJSON<{ vector: boolean; misses: { length: number; touches: string[] }[]; extras: { length: number; kind: string; id: string | null }[] }>(path.join(dir, "overlay.json"));
  const items = new Map(model.items.map((i) => [i.id, i]));
  const lines = new Map(model.lines.map((l) => [l.id, l]));
  const byTag = new Map<string, string[]>();
  for (const i of model.items) {
    const k = normTag(i.tag);
    if (k) byTag.set(k, [...(byTag.get(k) ?? []), i.id]);
  }
  const name = (id: string) => {
    const it = items.get(id);
    return !it ? id : it.tag ? `${it.tag} [${id}]` : `untagged ${it.type || it.category} [${id}]`;
  };
  const lineItems = (l: Line) => [l.from.ref, l.to.ref, ...l.components].filter((x): x is string => Boolean(x && items.has(x)));
  const issues: Issue[] = [];
  const unplaced: string[] = [];

  // open points: about an item (by id or tag) or a run
  for (const a of model.ambiguities) {
    const ids = items.has(a.tag) ? [a.tag] : lines.has(a.tag) ? lineItems(lines.get(a.tag)!) : (byTag.get(normTag(a.tag) ?? "") ?? []);
    // other tags or ids named in the text
    const named = [...a.issue.matchAll(/[A-Za-z0-9][A-Za-z0-9_.\-/]*[0-9][A-Za-z0-9_.\-/]*/g)].flatMap((m) => (items.has(m[0]) ? [m[0]] : (byTag.get(normTag(m[0]) ?? "") ?? [])));
    const all = [...new Set([...ids, ...named])].slice(0, 8);
    if (all.length) issues.push({ kind: "open_point", text: `${a.tag}: ${a.issue}`, items: all, ambiguity: a });
    else unplaced.push(`${a.tag}: ${a.issue}`);
  }
  if (ov?.vector) {
    const seen = new Set<string>();
    let n = 0;
    for (const m of ov.misses) {
      if (n >= MAX_OVERLAY || m.length < MIN_PX || !m.touches.length) continue;
      const key = [...m.touches].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      issues.push({
        kind: "missed",
        text: `a drawn line ${m.touches.length === 1 ? `leaving ${name(m.touches[0])}` : `between ${m.touches.map(name).join(", ")}`} is not used by the earlier reading. It may be a pipe or signal line that was missed, or something that is neither (a shaft, a frame, a leader): check what it is before adding anything.`,
        items: m.touches.filter((t) => items.has(t)),
      });
    }
    n = 0;
    for (const e of ov.extras) {
      if (n >= MAX_OVERLAY || e.length < MIN_PX || !e.id) continue;
      const base = e.id.split(".")[0];
      if (seen.has(`x:${base}:${e.kind}`)) continue;
      seen.add(`x:${base}:${e.kind}`);
      const l = lines.get(base);
      if (e.kind === "pipe" && l) {
        n++;
        issues.push({ kind: "invented", text: `run ${l.id}${l.line_id ? ` (${l.line_id})` : ""}: part of its route is not on the drawing; check its end points and the order of its components.`, items: lineItems(l) });
      } else if ((e.kind === "signal" || e.kind === "instrument") && items.has(base)) {
        n++;
        issues.push({ kind: "invented", text: e.kind === "signal" ? `a signal from ${name(base)}: no line is drawn where it was placed; check what it connects to.` : `${name(base)}: its connection to the process is not drawn where it was placed; check where it taps the pipe or vessel.`, items: [base] });
      }
    }
  }
  const nt = notes.trim();
  if (nt) {
    const named = [...new Set([...nt.matchAll(/[A-Za-z0-9][A-Za-z0-9_.\-/]*[0-9][A-Za-z0-9_.\-/]*/g)].flatMap((m) => (items.has(m[0]) ? [m[0]] : (byTag.get(normTag(m[0]) ?? "") ?? []))))];
    if (named.length) issues.push({ kind: "note", text: `engineer's note: ${nt}`, items: named.slice(0, 10) });
  }
  return { issues, unplaced };
}

export interface Area {
  r: Region;
  issues: Issue[];
}

/** Group the points into zoomed regions: nearby points share one look. */
function areas(model: DrawingModel, pages: PageImage[], issues: Issue[]): { list: Area[]; dropped: Issue[] } {
  const items = new Map(model.items.map((i) => [i.id, i]));
  const boxes: { page: number; b: BBox; issue: Issue }[] = [];
  for (const issue of issues) {
    const its = issue.items.map((id) => items.get(id)).filter((x): x is Item => Boolean(x));
    for (const page of new Set(its.map((i) => i.page))) {
      const on = its.filter((i) => i.page === page);
      boxes.push({ page, b: [Math.min(...on.map((i) => i.bbox[0])), Math.min(...on.map((i) => i.bbox[1])), Math.max(...on.map((i) => i.bbox[2])), Math.max(...on.map((i) => i.bbox[3]))], issue });
    }
  }
  const out: { page: number; b: BBox; issues: Issue[] }[] = [];
  const pad = (pg: PageImage, b: BBox): BBox => {
    const m = 0.05 * Math.max(pg.W, pg.H), min = 0.2 * Math.max(pg.W, pg.H);
    let [x0, y0, x1, y1] = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    if (x1 - x0 < min) [x0, x1] = [(x0 + x1) / 2 - min / 2, (x0 + x1) / 2 + min / 2];
    if (y1 - y0 < min) [y0, y1] = [(y0 + y1) / 2 - min / 2, (y0 + y1) / 2 + min / 2];
    return [Math.max(0, x0), Math.max(0, y0), Math.min(pg.W, x1), Math.min(pg.H, y1)];
  };
  const maxSide = (pg: PageImage) => 0.5 * Math.max(pg.W, pg.H);
  for (const x of boxes) {
    const pg = pages.find((p) => p.n === x.page);
    if (!pg) continue;
    const b = pad(pg, x.b);
    const host = out.find((o) => {
      if (o.page !== x.page) return false;
      const u: BBox = [Math.min(o.b[0], b[0]), Math.min(o.b[1], b[1]), Math.max(o.b[2], b[2]), Math.max(o.b[3], b[3])];
      const overlap = !(b[0] > o.b[2] || b[2] < o.b[0] || b[1] > o.b[3] || b[3] < o.b[1]);
      return overlap && u[2] - u[0] <= maxSide(pg) && u[3] - u[1] <= maxSide(pg);
    });
    if (host) {
      host.b = [Math.min(host.b[0], b[0]), Math.min(host.b[1], b[1]), Math.max(host.b[2], b[2]), Math.max(host.b[3], b[3])];
      if (!host.issues.includes(x.issue)) host.issues.push(x.issue);
    } else out.push({ page: x.page, b, issues: [x.issue] });
  }
  out.sort((a, b) => b.issues.length - a.issues.length);
  const keep = out.slice(0, MAX_REGIONS);
  const kept = new Set(keep.flatMap((o) => o.issues));
  return {
    list: keep.map((o, k) => ({ r: { id: `c${o.page}_${k + 1}`, page: o.page, x: o.b[0], y: o.b[1], w: o.b[2] - o.b[0], h: o.b[3] - o.b[1] }, issues: o.issues })),
    dropped: issues.filter((i) => !kept.has(i)),
  };
}

// the API allows few nullable fields per schema (the item findings use most): "" stands for none here
const text = (d: string) => ({ type: "string", description: `${d}; "" if none` });
const END = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "ref", "after"],
  properties: {
    kind: (endpoint as { properties: { kind: unknown } }).properties.kind,
    ref: text("equipment/off-page item id, or a run id for kind=line"),
    after: text("kind=line only: id of the component on that run after which this branch joins"),
  },
};
const RUN_FIX = {
  type: "object",
  additionalProperties: false,
  required: ["key", "action", "line_id", "size", "spec", "service", "from", "to", "components", "insulation", "confidence", "reason"],
  properties: {
    key: { type: "string", description: "replace/remove: the existing run id; add: NEW1, NEW2, …" },
    action: { type: "string", enum: ["replace", "remove", "add"] },
    line_id: text("printed line number"),
    size: text("size"),
    spec: text("spec"),
    service: text("fluid / utility"),
    from: END,
    to: END,
    components: { type: "array", items: { type: "string" }, description: "item ids in flow order (for an item you report as missing: its tag)" },
    insulation: text("insulation"),
    confidence: { type: "number" },
    reason: { type: "string" },
  },
};
const CORRECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["points", "findings", "runs"],
  properties: {
    points: {
      type: "array",
      description: "One entry per numbered point to check",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "status", "note"],
        properties: {
          n: { type: "integer" },
          status: { type: "string", enum: ["resolved", "was_right", "still_open"] },
          note: { type: "string", description: "One sentence: what you saw and what you changed" },
        },
      },
    },
    findings: (AUDIT_SCHEMA as { properties: { findings: unknown } }).properties.findings,
    runs: { type: "array", items: RUN_FIX },
  },
};
interface RunFix extends Omit<Line, "id" | "page"> {
  key: string;
  action: "replace" | "remove" | "add";
  reason: string;
}
export interface CorrectReply {
  points: { n: number; status: "resolved" | "was_right" | "still_open"; note: string }[];
  findings: Finding[];
  runs: RunFix[];
}

export interface CorrectionResult {
  regions: number;
  points: number;
  resolved: number;
  wasRight: number;
  open: number;
  findings: number;
  runsChanged: number;
  /** changes kept, and those not kept because they made the overlay worse */
  kept: number;
  rejected: string[];
  notes: string[];
}

/**
 * `judge` scores a model copy by how well its drawing lies on the PDF (null: cannot tell, e.g. a scan);
 * it may change the copy it gets. `model` is replaced by the corrected reading.
 */
export async function correct(ctx: RunContext, model: DrawingModel, pages: PageImage[], notes: string, judge: (m: DrawingModel) => Promise<number | null>): Promise<CorrectionResult> {
  const { issues, unplaced } = correctionIssues(ctx.dir, model, notes);
  const { list, dropped } = areas(model, pages, issues);
  ctx.log("verify", `correction: ${issues.length} points in ${list.length} zoomed regions${dropped.length ? ` (${dropped.length} points beyond the ${MAX_REGIONS} regions left as they are)` : ""}${unplaced.length ? `; ${unplaced.length} open points not tied to an item stay open` : ""}`);
  const system = systemPrompt({ ...ctx.settings, guidance: undefined }, model.standard);
  const res: CorrectionResult = { regions: list.length, points: 0, resolved: 0, wasRight: 0, open: 0, findings: 0, runsChanged: 0, kept: 0, rejected: [], notes: [] };
  const overview = new Map<number, { data: Buffer }>();
  for (const pg of pages) overview.set(pg.n, await cropForModel(pg.file, { x: 0, y: 0, w: pg.W, h: pg.H }, 1100));

  const replies = await Promise.all(
    list.map(async (a) => {
      const pg = pages.find((p) => p.n === a.r.page)!;
      const img = await cropForModel(pg.file, a.r);
      const local = model.items.filter((i) => i.page === a.r.page && inside(i.bbox, a.r));
      const localIds = new Set(local.map((i) => i.id));
      const runs = model.lines.filter((l) => l.page === a.r.page && [l.from.ref, l.to.ref, ...l.components].some((x) => x && localIds.has(x)));
      const ep = (e: Endpoint) => `${e.kind}${e.ref ? `:${e.ref}` : ""}${e.after ? ` after ${e.after}` : ""}`;
      const prompt = `You are CORRECTING an earlier reading of this P&ID, not reading it from scratch. Image 1 is the whole sheet (small); image 2 is the region to check at full detail. Boxes are 0–1000 relative to image 2.

Items of the earlier reading in this region (id, category, type, tag, box):
${local.map((i) => `${i.id}\t${i.category}\t${i.type}\ttag=${i.tag ?? "—"}\tbox=${JSON.stringify(toRegion(i.bbox, a.r))}`).join("\n") || "(none)"}

Pipe runs of the earlier reading that touch this region:
${runs.map((l) => `${l.id}\tline_id=${l.line_id ?? "—"}\tsize=${l.size ?? "—"}\tservice=${l.service ?? "—"}\tfrom=${ep(l.from)}\tto=${ep(l.to)}\tcomponents=[${l.components.join(", ")}]`).join("\n") || "(none)"}

Points to check here:
${a.issues.map((x, k) => `${k + 1}. ${x.text}`).join("\n")}
${notes.trim() ? `\nNotes from the engineer who checked the earlier reading (most important):\n${notes.trim()}\n` : ""}
Rules:
- Change only what image 2 shows is wrong. Whatever you do not mention stays exactly as it is. If a point turns out to be right as it was, its status is was_right and you change nothing for it.
- Items: report each correction as a finding (missing / hallucinated / wrong_tag / wrong_type / wrong_attribute / duplicate / wrong_category / wrong_position), boxes relative to image 2, item_id = the listed id.
- Runs: to correct a run, give it complete with action replace and its existing id as key (all fields, all its components in flow order, also those outside this region). A run the drawing does not show: action remove. A run the earlier reading missed: action add, key NEW1, NEW2 … End points refer to item ids, or for kind=line to a run id. Components are item ids; for an item you report as missing, use its tag.
- For every numbered point give its status: resolved (you corrected it), was_right, or still_open (the drawing does not settle it).`;
      try {
        const reply = await callJSON<CorrectReply>(ctx, {
          stage: "verify",
          label: `correction ${a.r.id} (${a.issues.length} points)`,
          system,
          prompt,
          images: [
            { data: overview.get(a.r.page)!.data, mediaType: "image/png", caption: "Image 1 — whole sheet:" },
            { data: img.data, mediaType: "image/png", caption: "Image 2 — region to check:" },
          ],
          schema: CORRECT_SCHEMA,
          effort: stepUp(ctx.settings.effort),
          maxTokens: 32000,
        });
        ctx.writeJSON(`work/correct_${a.r.id}.json`, { region: a.r, issues: a.issues, reply });
        return { a, reply };
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        ctx.log("verify", `correction ${a.r.id} failed: ${(e as Error).message}`);
        return { a, reply: null };
      }
    }),
  );

  if (list.length && replies.every((x) => !x.reply)) throw new Error(`none of the ${list.length} regions could be looked at again`);

  await applyReplies(ctx, model, replies, judge, res);
  return res;
}

/**
 * One change at a time, on a copy: a change is kept only when the drawing does not lie worse on the
 * PDF with it. One wrong pipe change then no longer costs the good item fixes around it. A point counts
 * as resolved only when no change about its items was turned down; a point that was right as it was is
 * settled either way. Exported to replay saved replies (work/correct_*.json) without model calls.
 */
export async function applyReplies(ctx: RunContext, model: DrawingModel, replies: { a: Area; reply: CorrectReply | null }[], judge: (m: DrawingModel) => Promise<number | null>, res: CorrectionResult) {
  const ambIndex = new Map(model.ambiguities.map((x, k) => [x, k]));
  const settled = new Set<number>();
  let cur = structuredClone(model);
  let curFit = await judge(structuredClone(cur));
  const pt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pt`;
  ctx.log("verify", `correction: overlay of the kept reading ${curFit === null ? "—" : `${(curFit * 100).toFixed(1)}%`}`);
  for (const { a, reply } of replies) {
    if (!reply) continue;
    // the region's changes one by one: each finding, each run fix; new runs together (they may refer to each other)
    // the region's changes one by one: each finding, each run fix; new runs together (they may refer to each other).
    // `touches`: the items and runs a change is about, to tell which points a change that is not kept concerns
    const runTouches = (f: RunFix) => [f.key, f.from.ref, f.from.after, f.to.ref, f.to.after, ...f.components];
    const steps: { what: string; part: CorrectReply; touches: (string | null)[] }[] = [
      ...reply.findings.filter((f) => f.confidence >= 0.6).map((f) => ({ what: `${f.kind} ${f.item_id ?? f.proposed?.tag ?? "new item"}`, part: { ...reply, findings: [f], runs: [] }, touches: [f.item_id, f.proposed?.tag ?? null] })),
      ...reply.runs.filter((f) => f.confidence >= 0.7 && f.action !== "add").map((f) => ({ what: `${f.action} ${f.key}`, part: { ...reply, findings: [], runs: [f] }, touches: runTouches(f) })),
    ];
    const adds = reply.runs.filter((f) => f.confidence >= 0.7 && f.action === "add");
    if (adds.length) steps.push({ what: `add ${adds.length} run${adds.length > 1 ? "s" : ""}`, part: { ...reply, findings: [], runs: adds }, touches: adds.flatMap(runTouches) });
    // what the changes that were not kept are about; null: a change about nothing nameable (concerns every point here)
    // changes too unsure to apply count the same: the point they would resolve is not resolved
    const unsure = [...reply.findings.filter((f) => f.confidence < 0.6).map((f) => [f.item_id, f.proposed?.tag ?? null]), ...reply.runs.filter((f) => f.confidence < 0.7).map(runTouches)];
    let notKept: Set<string> | null = unsure.some((t) => !t.some(Boolean)) ? null : new Set(unsure.flat().filter((x): x is string => Boolean(x)));
    for (const s of steps) {
      const cand = structuredClone(cur);
      const done = applyRegion(cand, a, s.part);
      if (!done.findings && !done.runsChanged) continue;
      const fit = await judge(structuredClone(cand));
      if (fit === null || curFit === null || fit >= curFit - CHANGE_SLACK) {
        cur = cand;
        curFit = fit ?? curFit;
        res.findings += done.findings;
        res.runsChanged += done.runsChanged;
        res.notes.push(...done.notes);
        res.kept++;
      } else {
        const t = s.touches.filter((x): x is string => Boolean(x));
        if (notKept) notKept = t.length ? new Set([...notKept, ...t]) : null;
        res.rejected.push(`${a.r.id}: ${s.what} (${pt(fit - curFit)})`);
      }
    }
    for (const p of reply.points) {
      const issue = a.issues[p.n - 1];
      if (!issue) continue;
      res.points++;
      // resolved only when no change that was not kept concerns this point's items
      const blocked = notKept === null ? true : issue.items.some((id) => notKept!.has(id)) || (!issue.items.length && notKept.size > 0);
      const status = p.status === "resolved" && blocked ? "still_open" : p.status;
      if (status === "resolved") res.resolved++;
      else if (status === "was_right") res.wasRight++;
      else res.open++;
      const k = issue.ambiguity ? ambIndex.get(issue.ambiguity) : undefined;
      if (k === undefined) continue;
      if (status !== "still_open") settled.add(k);
      else if (p.note) {
        // the open point keeps what the second look saw
        const amb = cur.ambiguities[k];
        if (amb) amb.issue = `${amb.issue} — correction${status !== p.status ? " (not all of it kept: some changes made the drawing lie worse on the PDF)" : ""}: ${p.note}`;
      }
    }
  }
  if (res.rejected.length) ctx.log("verify", `correction: ${res.rejected.length} changes not kept (overlay worse): ${res.rejected.join("; ")}`);
  // ambiguities are never added or removed above, so their order still matches the kept reading's
  cur.ambiguities = cur.ambiguities.filter((_, k) => !settled.has(k));
  cur.comments.push(
    `correction run: ${res.points} points looked at again in ${res.regions} regions → ${res.resolved} resolved, ${res.wasRight} were right, ${res.open} still open; ${res.findings} item corrections, ${res.runsChanged} runs changed${res.rejected.length ? `; ${res.rejected.length} changes not kept (overlay worse)` : ""}`,
  );
  // hand the result back in the caller's model object
  for (const k of Object.keys(model) as (keyof DrawingModel)[]) delete model[k];
  Object.assign(model, cur);
}

/** a change may cost at most this much overlay fit: one rounding step of the overlay (0.05 %-point) */
const CHANGE_SLACK = 0.0005;

/** Apply one region's reply to the model: its item findings, then its pipe-run fixes. */
function applyRegion(model: DrawingModel, a: Area, reply: CorrectReply): { findings: number; runsChanged: number; notes: string[] } {
  const out = { findings: 0, runsChanged: 0, notes: [] as string[] };
  // items first (runs may name items added here by their tag)
  const removed = new Set<string>();
  for (const f of reply.findings) {
    if (f.confidence < 0.6) continue; // too unsure to change a reading that was kept
    applyFinding(model, f, a.r, `correction:${a.r.id}`, "correction", removed);
    out.findings++;
  }
  settle(model, removed);

  // pipe runs
  const page = a.r.page;
  const ids = new Set(model.items.map((i) => i.id));
  const byTag = new Map<string, string>();
  for (const i of model.items) {
    const k = normTag(i.tag);
    if (k && !byTag.has(`${i.page}|${k}`)) byTag.set(`${i.page}|${k}`, i.id);
  }
  const resolve = (ref: string | null) => (!ref ? null : ids.has(ref) ? ref : (byTag.get(`${page}|${normTag(ref)}`) ?? null));
  const newIds = new Map<string, string>();
  for (const f of reply.runs.filter((x) => x.action === "add")) {
    let n = model.lines.length + 1, id = `L${page}-${String(n).padStart(3, "0")}`;
    while (model.lines.some((l) => l.id === id) || [...newIds.values()].includes(id)) id = `L${page}-${String(++n).padStart(3, "0")}`;
    newIds.set(f.key, id);
  }
  const runRef = (r: string | null) => (r && model.lines.some((l) => l.id === r) ? r : r ? (newIds.get(r) ?? null) : null);
  const fixEp = (e: Endpoint): Endpoint => {
    if (e.kind === "line") {
      const ref = runRef(e.ref);
      return ref ? { kind: "line", ref, after: resolve(e.after) } : { kind: "open", ref: null, after: null };
    }
    if (e.kind === "equipment" || e.kind === "off_page") {
      const ref = resolve(e.ref);
      return ref ? { kind: e.kind, ref, after: null } : { kind: "open", ref: null, after: null };
    }
    return { kind: "open", ref: null, after: null };
  };
  for (const f of reply.runs) {
    if (f.confidence < 0.7) continue;
    const old = model.lines.find((l) => l.id === f.key);
    if (f.action === "remove") {
      if (!old) continue;
      model.lines = model.lines.filter((l) => l !== old);
      for (const l of model.lines) for (const e of [l.from, l.to]) if (e.kind === "line" && e.ref === old.id) Object.assign(e, { kind: "open", ref: null, after: null });
      out.notes.push(`${old.id} removed: ${f.reason}`);
      out.runsChanged++;
      continue;
    }
    const comps = [...new Set(f.components.map(resolve).filter((x): x is string => Boolean(x)))];
    const nn = (x: string | null) => (x && x.trim() ? x.trim() : null);
    const fixed: Line = { id: f.action === "add" ? newIds.get(f.key)! : (old?.id ?? ""), page, line_id: nn(f.line_id), size: nn(f.size), spec: nn(f.spec), service: nn(f.service), from: fixEp(f.from), to: fixEp(f.to), components: comps, insulation: nn(f.insulation), confidence: f.confidence };
    if (f.action === "replace") {
      if (!old) continue;
      // keep what the vector layer knew about the ends when they stay the same
      for (const k of ["from", "to"] as const) if (old[k].kind === fixed[k].kind && old[k].ref === fixed[k].ref) fixed[k] = { ...old[k], after: fixed[k].after };
      Object.assign(old, fixed);
      out.notes.push(`${old.id} corrected: ${f.reason}`);
    } else {
      model.lines.push(fixed);
      out.notes.push(`${fixed.id} added: ${f.reason}`);
    }
    out.runsChanged++;
  }
  // a component now on two runs: keep it where this region put it
  if (out.runsChanged) {
    const owner = new Map<string, Line>();
    for (const l of model.lines) for (const c of l.components) owner.set(c, l);
    for (const l of model.lines) l.components = l.components.filter((c) => owner.get(c) === l);
  }
  return out;
}
