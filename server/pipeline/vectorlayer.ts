import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { BBox, DrawingModel, Endpoint, Item, Line, PipeRoute, SignalLine, SignalLineType } from "../types.ts";
import type { RunContext } from "./context.ts";
import type { PageImage } from "./locate.ts";
import { normTag, splitInstrumentTag } from "./merge.ts";
import { buildNets, netPath, pipedNeighbours, type Net, type Pt } from "./nets.ts";
import type { Token } from "./ocr.ts";
import { extractVectorPage, type Seg, type VectorPage } from "./vector.ts";

/**
 * The vector layer in the pipeline:
 *  - exact words from the PDF join (and outrank) the OCR tokens;
 *  - nets (connected drawn lines) give the connect stage hard evidence of what is piped to what;
 *  - after tracing, open run ends and unlinked instruments are settled from the nets where the
 *    geometry leaves one answer.
 * A scanned sheet has no vectors; everything here is then a no-op.
 */

/** The PDF this project was made from (staged copy in the project folder). */
export function sourcePdf(dir: string, source: string): string | null {
  const f = path.join(dir, "source", source);
  return /\.pdf$/i.test(f) && fs.existsSync(f) ? f : null;
}

export function loadVector(ctx: RunContext, pages: { n: number; W: number; H: number }[]): Map<number, VectorPage> {
  const cached = ctx.bag.vector as Map<number, VectorPage> | undefined;
  if (cached) return cached;
  const out = new Map<number, VectorPage>();
  const pdf = sourcePdf(ctx.dir, ctx.state.source);
  if (pdf) for (const p of pages) out.set(p.n, extractVectorPage(pdf, p.n, [p.W, p.H]));
  ctx.bag.vector = out;
  return out;
}

export function vectorSummary(v: Map<number, VectorPage>) {
  return [...v.values()].map((p) => `page ${p.n}: ${p.kind === "vector" ? `${p.segs.length} vector strokes, ${p.words.length} text words` : "scan (no vectors)"}`).join("; ");
}

// ---------------------------------------------------------------- words → tokens

/** PDF words as tokens. Exact text and position, so they replace OCR readings of the same spot. */
export function mergeWordTokens(ocr: Token[], v: Map<number, VectorPage>): { tokens: Token[]; words: number } {
  const words: Token[] = [];
  for (const p of v.values()) {
    // complete text layer: a CAD sheet (many strokes) that prints its text as text, not as outlines;
    // a scan with a hidden OCR layer or a sheet with outlined text has only some of its words
    const complete = p.segs.length > 2000 && p.words.length >= 200;
    for (const w of p.words) {
      const norm = normTag(w.text) ?? "";
      if (!norm) continue;
      words.push({ page: p.n, text: w.text, norm, conf: 1, complete, box: w.box.map(Math.round) as BBox, vertical: w.box[3] - w.box[1] > 1.6 * (w.box[2] - w.box[0]) && w.text.length > 1 });
    }
  }
  if (!words.length) return { tokens: ocr, words: 0 };
  const inside = (a: BBox, b: BBox) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return ix / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  };
  const keep = ocr.filter((t) => !words.some((w) => w.page === t.page && inside(t.box, w.box) > 0.4));
  return { tokens: [...words, ...keep], words: words.length };
}

// ---------------------------------------------------------------- bubbles

/**
 * An instrument read without a tag (the model saw a bubble but gave only its type) takes the letter
 * code printed in it (PI, TT on sheets without loop numbers) from the text layer: the letters-only
 * word inside its box, or else the nearest one within a bubble's reach — but only a word no other
 * instrument box holds and that lies nearer to this instrument than to any other. The box is then
 * centred on that word, so the bubble fit can find the circle around it.
 */
export function tagsFromText(ctx: RunContext, model: DrawingModel, pages: { n: number; W: number; H: number }[]): string[] {
  const v = loadVector(ctx, pages);
  const notes: string[] = [];
  const ctr = (b: BBox): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  for (const pg of pages) {
    const vp = v.get(pg.n);
    if (!vp || vp.kind !== "vector") continue;
    const ins = model.items.filter((i) => i.page === pg.n && i.category === "instrument");
    const sides = ins.filter((i) => i.tag).map((i) => Math.max(i.bbox[2] - i.bbox[0], i.bbox[3] - i.bbox[1])).sort((a, b) => a - b);
    const side = sides.length ? sides[Math.floor(sides.length / 2)] : 60;
    const words = vp.words.filter((w) => /^[A-Z]{1,5}$/.test(w.text.trim())).map((w) => ({ text: w.text.trim(), c: ctr(w.box) }));
    const inBox = (p: Pt, b: BBox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
    for (const it of ins.filter((i) => !i.tag)) {
      const c = ctr(it.bbox);
      const d = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const cands = words
        .filter((w) => inBox(w.c, it.bbox) || d(w.c, c) <= side * 0.75)
        .filter((w) => !ins.some((o) => o !== it && inBox(w.c, o.bbox)))
        .filter((w) => !ins.some((o) => o !== it && d(w.c, ctr(o.bbox)) < d(w.c, c)))
        .sort((a, b) => d(a.c, c) - d(b.c, c));
      const w = cands[0];
      if (!w || (cands[1] && cands[1].text !== w.text && d(cands[1].c, c) < 1.3 * d(w.c, c))) continue;
      it.tag = w.text;
      if (!inBox(w.c, it.bbox)) {
        const h = Math.max(it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1], side) / 2;
        it.bbox = [w.c[0] - h, w.c[1] - h, w.c[0] + h, w.c[1] + h].map(Math.round) as BBox;
      }
      const tagNote = "tag from the printed letter code (text layer)";
      if (!it.note?.includes(tagNote)) it.note = [it.note, tagNote].filter(Boolean).join("; ");
      notes.push(`${it.id}=${w.text}`);
    }
  }
  return notes;
}

/**
 * A tag in a frame with a leader line (an oval "1CTV6" with an arrow to the valve) read as the valve
 * itself: the box sits on the label, and the drawn symbol at the arrow was not read. On vector pages:
 * a tagged valve / piping component whose box is a wide frame (a straight top and bottom edge across
 * most of it) with exactly one leader (a solid straight line leaving the frame, followed to an
 * arrowhead) moves to the leader's tip — onto the drawn symbol read there without a tag (that item
 * then merges into this one), or else onto the pipe at the tip.
 */
export function labelLeaders(ctx: RunContext, model: DrawingModel, pages: { n: number; W: number; H: number }[]): string[] {
  const v = loadVector(ctx, pages);
  const notes: string[] = [];
  const d = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const ctr = (b: BBox): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const inB = (p: Pt, b: BBox, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
  const PIPED = new Set(["valve", "piping_component"]);
  for (const pg of pages) {
    const vp = v.get(pg.n);
    if (!vp || vp.kind !== "vector") continue;
    const items = model.items.filter((i) => i.page === pg.n);
    const sym = items.filter((i) => PIPED.has(i.category)).map((i) => [i.bbox[2] - i.bbox[0], i.bbox[3] - i.bbox[1]]).filter(([w, h]) => w <= 1.6 * h && h <= 1.6 * w).map(([w, h]) => Math.max(w, h)).sort((a, b) => a - b);
    const S = sym.length ? sym[Math.floor(sym.length / 2)] : 0.006 * pg.W;
    const solid = vp.segs.filter((sg) => !sg.curve && !sg.dash);
    for (const it of items.filter((i) => PIPED.has(i.category) && i.tag)) {
      const b = it.bbox, w = b[2] - b[0], h = b[3] - b[1];
      if (w < 1.8 * h || w < 1.5 * S) continue;
      // the frame: straight top and bottom edges across most of the box
      const g = Math.max(12, 0.5 * h);
      const edges = solid.filter((sg) => Math.abs(sg.a[1] - sg.b[1]) <= 2 && Math.abs(sg.a[0] - sg.b[0]) >= 0.6 * w && inB(sg.a, b, g) && inB(sg.b, b, g));
      const ys = edges.map((sg) => sg.a[1]);
      if (!ys.length || Math.max(...ys) - Math.min(...ys) < 0.5 * h) continue;
      const framePaths = new Set(edges.map((sg) => sg.path));
      // leaders: a solid line with one end at the frame and the other away from it, followed to its tip
      const tips: { tip: Pt; dir: Pt; used: Set<Seg> }[] = [];
      for (const s0 of solid) {
        if (edges.includes(s0)) continue;
        const [pIn, pOut] = inB(s0.a, b, g) && !inB(s0.b, b, g) ? [s0.a, s0.b] : inB(s0.b, b, g) && !inB(s0.a, b, g) ? [s0.b, s0.a] : [null, null];
        if (!pIn || !pOut) continue;
        const used = new Set<Seg>([s0]);
        let prev: Pt = pIn, end: Pt = pOut, L = d(pIn, pOut);
        for (let k = 0; k < 5; k++) {
          const next = solid.filter((sg) => !used.has(sg) && (d(sg.a, end) <= 3 || d(sg.b, end) <= 3));
          if (next.length !== 1) break;
          const sg = next[0];
          used.add(sg);
          prev = end;
          end = d(sg.a, end) <= 3 ? sg.b : sg.a;
          L += d(sg.a, sg.b);
        }
        if (L < h) continue;
        // an arrowhead (a filled shape) at the tip
        if (!vp.fills.some((f) => inB(end, f, 6))) continue;
        const len = d(prev, end) || 1;
        tips.push({ tip: end, dir: [(end[0] - prev[0]) / len, (end[1] - prev[1]) / len], used });
      }
      if (tips.length !== 1) continue;
      const { tip, dir, used } = tips[0];
      // the symbol read at the tip without a tag
      const sym2 = items
        .filter((o) => o !== it && PIPED.has(o.category) && (!o.tag || o.tag === it.tag) && inB(tip, o.bbox, 0.5 * S))
        .sort((x, y) => d(ctr(x.bbox), tip) - d(ctr(y.bbox), tip))[0];
      const old = it.bbox;
      it.label_box = old;
      if (sym2) {
        it.bbox = sym2.bbox;
        if (sym2.type) it.type = sym2.type;
        replaceItem(model, sym2.id, it.id);
        notes.push(`${it.tag}: label → ${sym2.id}`);
      } else {
        // the pipe at the tip: the nearest drawn line (not the label, not the leader) across the tip's way
        let best: { c: Pt; dd: number; sg: Seg } | null = null;
        for (const sg of solid) {
          if (used.has(sg) || framePaths.has(sg.path) || d(sg.a, sg.b) < 1.5 * S) continue;
          const ux = sg.b[0] - sg.a[0], uy = sg.b[1] - sg.a[1], L2 = ux * ux + uy * uy;
          const t = ((tip[0] - sg.a[0]) * ux + (tip[1] - sg.a[1]) * uy) / L2;
          const tc = Math.max(0, Math.min(1, t));
          const near = d(tip, [sg.a[0] + tc * ux, sg.a[1] + tc * uy]);
          const c: Pt = [sg.a[0] + t * ux, sg.a[1] + t * uy]; // on the line through the piece (the symbol cuts it)
          const dd = d(tip, c);
          if (near > 2.5 * S || dd > 2.5 * S || (c[0] - tip[0]) * dir[0] + (c[1] - tip[1]) * dir[1] < -0.3 * S) continue;
          if (!best || dd < best.dd) best = { c, dd, sg };
        }
        let c: Pt = best ? best.c : [tip[0] + (dir[0] * S) / 2, tip[1] + (dir[1] * S) / 2];
        if (best) {
          // the symbol cuts the pipe: centre on the nearest gap between the drawn pieces of that line
          const { a } = best.sg, bb = best.sg.b;
          const Lu = d(a, bb), u: Pt = [(bb[0] - a[0]) / Lu, (bb[1] - a[1]) / Lu];
          const off = (p: Pt) => Math.abs((p[0] - a[0]) * u[1] - (p[1] - a[1]) * u[0]);
          const at = (p: Pt) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
          const iv = solid.filter((sg) => off(sg.a) <= 2 && off(sg.b) <= 2).map((sg) => [Math.min(at(sg.a), at(sg.b)), Math.max(at(sg.a), at(sg.b))]).sort((x, y) => x[0] - y[0]);
          const merged: number[][] = [];
          for (const x of iv) if (merged.length && x[0] <= merged[merged.length - 1][1] + 1) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x[1]); else merged.push([...x]);
          const tc = at(c);
          const gaps = merged.slice(1).map((x, k) => [merged[k][1], x[0]]).filter(([g0, g1]) => g1 - g0 >= 0.3 * S && g1 - g0 <= 3 * S);
          const gap = gaps.map(([g0, g1]) => (g0 + g1) / 2).filter((m) => Math.abs(m - tc) <= 1.5 * S).sort((x, y) => Math.abs(x - tc) - Math.abs(y - tc))[0];
          if (gap !== undefined) c = [a[0] + u[0] * gap, a[1] + u[1] * gap];
        }
        it.bbox = [c[0] - S / 2, c[1] - S / 2, c[0] + S / 2, c[1] + S / 2].map(Math.round) as BBox;
        notes.push(`${it.tag}: label → ${best ? "pipe" : "tip"} at ${c.map(Math.round).join(",")}`);
      }
      const n = `box moved from its tag label [${old.join(",")}] along the leader to the drawn symbol`;
      if (!it.note?.includes("tag label")) it.note = [it.note, n].filter(Boolean).join("; ");
    }
  }
  return notes;
}

/** Every reference to item `from` (runs, signals, routes) now points at `to`; `from` leaves the model. */
function replaceItem(model: DrawingModel, from: string, to: string) {
  model.items = model.items.filter((i) => i.id !== from);
  const swap = <T>(x: T): T => JSON.parse(JSON.stringify(x).split(`"${from}"`).join(`"${to}"`));
  for (const k of Object.keys(model) as (keyof DrawingModel)[]) {
    if (k === "items" || k === "pages" || k === "document") continue;
    const val = model[k];
    if (val && typeof val === "object") (model as unknown as Record<string, unknown>)[k] = swap(val);
  }
  for (const l of model.lines) l.components = l.components.filter((c, k, a) => a.indexOf(c) === k);
}

/**
 * Instrument boxes to the drawn circle. A box anchored on its printed words is only as wide as
 * the text ("PI" without a number gives a box a third of the bubble), so lines leaving the bubble
 * do not reach it. Look for curve pieces (circle arcs) near the text that lie on one circle on at
 * least three sides (centre searched: the text often sits above the middle). Bubbles on one sheet
 * share a size, so only circles near the sheet's usual bubble radius count. Square symbols and
 * scans keep their box.
 */
export function fitBubbles(ctx: RunContext, model: DrawingModel, pages: { n: number; W: number; H: number }[]): number {
  const v = loadVector(ctx, pages);
  const fits: { it: Item; c: [number, number]; r: number }[] = [];
  for (const it of model.items) {
    if (it.category !== "instrument") continue;
    const vp = v.get(it.page);
    if (!vp || vp.kind !== "vector") continue;
    const half = Math.max(it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1]) / 2;
    const c0: [number, number] = [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2];
    const reach = Math.max(2.6 * half, 60);
    const arcs = vp.segs.filter((s) => s.curve && Math.hypot(s.a[0] - c0[0], s.a[1] - c0[1]) < reach && Math.hypot(s.b[0] - c0[0], s.b[1] - c0[1]) < reach);
    if (arcs.length < 3) continue;
    // arc pieces with both ends on one circle, all round it (no gap over 120°), centre near the text
    let best: { c: [number, number]; r: number; hits: number } | null = null;
    const step = Math.max(1, half / 8);
    for (let dx = -half; dx <= half; dx += step)
      for (let dy = -half; dy <= half; dy += step) {
        const c: [number, number] = [c0[0] + dx, c0[1] + dy];
        const da = arcs.map((s) => ({ s, a: Math.hypot(s.a[0] - c[0], s.a[1] - c[1]), b: Math.hypot(s.b[0] - c[0], s.b[1] - c[1]) }));
        for (const { a: r } of da) {
          if (r < Math.max(6, 0.9 * half)) continue;
          const tol = Math.max(1.5, 0.05 * r);
          const on = da.filter((x) => Math.abs(x.a - r) <= tol && Math.abs(x.b - r) <= tol);
          if (on.length < 3 || (best && on.length < best.hits)) continue;
          const ang = on.flatMap(({ s }) => [s.a, s.b]).map((q) => Math.atan2(q[1] - c[1], q[0] - c[0])).sort((x, y) => x - y);
          const gap = Math.max(...ang.map((x, k) => (k ? x - ang[k - 1] : x + 2 * Math.PI - ang[ang.length - 1])));
          if (gap > (2 * Math.PI) / 3) continue;
          if (!best || on.length > best.hits || r < best.r) best = { c, r, hits: on.length };
        }
      }
    if (best) fits.push({ it, c: best.c, r: best.r });
  }
  // the sheet's usual bubble radius: keep circles close to it
  let n = 0;
  for (const page of new Set(fits.map((f) => f.it.page))) {
    const rs = fits.filter((f) => f.it.page === page).map((f) => f.r).sort((a, b) => a - b);
    const med = rs[rs.length >> 1];
    for (const f of fits.filter((f) => f.it.page === page)) {
      if (f.r < 0.85 * med || f.r > 1.25 * med) continue;
      const nb = [f.c[0] - f.r, f.c[1] - f.r, f.c[0] + f.r, f.c[1] + f.r].map(Math.round) as BBox;
      if (nb.every((x, k) => Math.abs(x - f.it.bbox[k]) <= 2)) continue;
      f.it.bbox = nb;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- equipment outlines

/**
 * Equipment boxes to their drawn outline. Tiles often see only the tag of a big apparatus (a heat
 * exchanger read as its 18×35 px label), so pipes end beside it and nozzles collapse into one point.
 * Closed outlines on the sheet: two parallel straight sides of equal span, closed at both ends by a
 * straight side (rectangle) or by arcs (dished heads, rounded ends). An item takes the smallest
 * such outline that holds its box (or lies right next to it) and holds no other equipment and at
 * most one valve or instrument — a loop of pipes around a few valves is not an apparatus.
 */
export function fitEquipment(ctx: RunContext, model: DrawingModel, pages: { n: number; W: number; H: number }[]): string[] {
  const v = loadVector(ctx, pages);
  const notes: string[] = [];
  for (const pg of pages) {
    const vp = v.get(pg.n);
    if (!vp || vp.kind !== "vector") continue;
    const items = model.items.filter((i) => i.page === pg.n);
    const eqs = items.filter((i) => i.category === "equipment");
    if (!eqs.length) continue;
    const outlines = closedOutlines(vp.segs, pg.W * pg.H * 0.08);
    const ctr = (b: BBox): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const inside = (p: Pt, b: BBox, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
    const area = (b: BBox) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
    for (const it of eqs) {
      const c = ctr(it.bbox);
      const size = Math.max(it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1]);
      const fits = outlines
        .filter((o) => {
          const w = o[2] - o[0], h = o[3] - o[1];
          if (Math.min(w, h) < 40 || Math.max(w, h) / Math.min(w, h) > 8) return false;
          if (area(o) < 1.5 * area(it.bbox) || !inside(c, o, Math.max(20, size * 0.6))) return false;
          // the box read from the tiles mostly lies within the outline (a label sits inside or beside it)
          const ov = Math.max(0, Math.min(o[2], it.bbox[2]) - Math.max(o[0], it.bbox[0])) * Math.max(0, Math.min(o[3], it.bbox[3]) - Math.max(o[1], it.bbox[1]));
          return ov >= 0.5 * area(it.bbox) || size <= 120;
        })
        .filter((o) => {
          const others = items.filter((x) => x !== it && inside(ctr(x.bbox), o));
          return !others.some((x) => x.category === "equipment") && others.filter((x) => x.category === "valve" || x.category === "instrument").length <= 1;
        })
        .sort((a, b) => area(a) - area(b));
      const o = fits[0];
      if (!o) continue;
      // a box that already covers most of the outline is right as it is
      const ov = Math.max(0, Math.min(o[2], it.bbox[2]) - Math.max(o[0], it.bbox[0])) * Math.max(0, Math.min(o[3], it.bbox[3]) - Math.max(o[1], it.bbox[1]));
      if (ov >= 0.8 * area(o)) continue;
      const was = `${Math.round(it.bbox[2] - it.bbox[0])}×${Math.round(it.bbox[3] - it.bbox[1])}`;
      it.bbox = o.map(Math.round) as BBox;
      const tagNote = "box from its drawn outline (vector layer)";
      if (!it.note?.includes(tagNote)) it.note = [it.note, tagNote].filter(Boolean).join("; ");
      notes.push(`${it.tag ?? it.id} ${was} → ${Math.round(o[2] - o[0])}×${Math.round(o[3] - o[1])} at ${o.map(Math.round).join(",")}`);
    }
  }
  return notes;
}

/** Closed outlines (boxes) on a vector page: rectangles and parallel sides closed by arcs. */
function closedOutlines(segs: Seg[], maxArea: number): BBox[] {
  const tol = 2.5;
  // straight horizontal / vertical sides, collinear pieces joined (nozzles and tees split a side)
  const lines = (horiz: boolean) => {
    const ax = horiz ? 0 : 1, cr = horiz ? 1 : 0;
    const raw = segs
      .filter((s) => !s.curve && !s.dash && Math.abs(s.a[cr] - s.b[cr]) < 0.6 && Math.abs(s.a[ax] - s.b[ax]) > 3)
      .map((s) => ({ c: (s.a[cr] + s.b[cr]) / 2, lo: Math.min(s.a[ax], s.b[ax]), hi: Math.max(s.a[ax], s.b[ax]) }))
      .sort((p, q) => p.c - q.c || p.lo - q.lo);
    const out: { c: number; lo: number; hi: number }[] = [];
    for (const r of raw) {
      const last = out.find((o) => Math.abs(o.c - r.c) < 0.8 && r.lo <= o.hi + tol && r.hi >= o.lo - tol);
      if (last) {
        last.lo = Math.min(last.lo, r.lo);
        last.hi = Math.max(last.hi, r.hi);
      } else out.push({ ...r });
    }
    return out.filter((l) => l.hi - l.lo >= 30);
  };
  const H = lines(true), V = lines(false);
  const curveEnds = segs.filter((s) => s.curve).flatMap((s) => [s.a, s.b]);
  const covered = (ls: typeof H, c: number, lo: number, hi: number) => {
    const parts = ls.filter((l) => Math.abs(l.c - c) <= tol && l.hi > lo && l.lo < hi).map((l) => [Math.max(lo, l.lo), Math.min(hi, l.hi)]).sort((a, b) => a[0] - b[0]);
    let sum = 0, end = lo;
    for (const [a, b] of parts) if (b > end) { sum += b - Math.max(a, end); end = b; }
    return sum / Math.max(1, hi - lo);
  };
  // an end closed by arcs: curve pieces start at both corners and bulge outward
  const arcEnd = (corner1: Pt, corner2: Pt, out: Pt): number | null => {
    const near = (p: Pt) => curveEnds.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol);
    if (!near(corner1) || !near(corner2)) return null;
    const span = Math.hypot(corner2[0] - corner1[0], corner2[1] - corner1[1]);
    const mid: Pt = [(corner1[0] + corner2[0]) / 2, (corner1[1] + corner2[1]) / 2];
    // furthest curve point beyond the corners, in the outward direction, within the span
    let reach = 0;
    for (const q of curveEnds) {
      const along = (q[0] - mid[0]) * out[0] + (q[1] - mid[1]) * out[1];
      const across = Math.abs((q[0] - mid[0]) * out[1] - (q[1] - mid[1]) * out[0]);
      if (along > 0 && along <= span && across <= span / 2 + tol) reach = Math.max(reach, along);
    }
    return reach > 0 ? reach : null;
  };
  const boxes: BBox[] = [];
  const pairs = (ls: typeof H, other: typeof H, horiz: boolean) => {
    const byLen = [...ls].sort((a, b) => a.lo - b.lo);
    for (let i = 0; i < byLen.length; i++)
      for (let j = i + 1; j < byLen.length && byLen[j].lo <= byLen[i].lo + tol; j++) {
        const [p, q] = [byLen[i], byLen[j]];
        if (Math.abs(p.hi - q.hi) > tol || Math.abs(p.c - q.c) < 15) continue;
        const [c1, c2] = p.c < q.c ? [p.c, q.c] : [q.c, p.c];
        const lo = (p.lo + q.lo) / 2, hi = (p.hi + q.hi) / 2;
        if ((hi - lo) * (c2 - c1) > maxArea) continue;
        const P = (along: number, cross: number): Pt => (horiz ? [along, cross] : [cross, along]);
        const dir = (s: number): Pt => (horiz ? [s, 0] : [0, s]);
        let a = lo, b = hi;
        if (covered(other, lo, c1, c2) < 0.8) {
          const r = arcEnd(P(lo, c1), P(lo, c2), dir(-1));
          if (r === null) continue;
          a = lo - r;
        }
        if (covered(other, hi, c1, c2) < 0.8) {
          const r = arcEnd(P(hi, c1), P(hi, c2), dir(1));
          if (r === null) continue;
          b = hi + r;
        }
        boxes.push(horiz ? [a, c1, b, c2] : [c1, a, c2, b]);
      }
  };
  pairs(H, V, true);
  pairs(V, H, false);
  // the same outline found from both directions: keep one
  const out: BBox[] = [];
  for (const b of boxes) if (!out.some((o) => o.every((x, k) => Math.abs(x - b[k]) <= 4))) out.push(b);
  return out;
}

// ---------------------------------------------------------------- nets

const NET_CATS = new Set(["equipment", "valve", "piping_component", "instrument", "off_page"]);

export function computeNets(ctx: RunContext, model: DrawingModel, pages: PageImage[]): Map<number, Net[]> {
  const v = loadVector(ctx, pages);
  const out = new Map<number, Net[]>();
  for (const p of pages) {
    const vp = v.get(p.n);
    if (!vp || vp.kind !== "vector") continue;
    const items = model.items.filter((i) => i.page === p.n && NET_CATS.has(i.category));
    const nets = buildNets(vp, p.W, { items, ignore: titleBlockBox(model, p, vp) });
    out.set(p.n, nets);
    ctx.writeJSON(`work/nets_p${p.n}.json`, nets.map(({ path: _p, ...n }) => n));
  }
  return out;
}

/** The title block is not process: skip its ruling. Taken from the profile when it was located, else found on the sheet. */
function titleBlockBox(model: DrawingModel, p: PageImage, vp: VectorPage): BBox[] {
  const tb = (model.title_block as unknown as { bbox?: BBox } | null)?.bbox;
  if (tb && tb.length === 4) return [tb];
  return findTitleBlock(vp, p.W, p.H, model.items.filter((i) => i.page === p.n));
}

/**
 * The title block from the drawn frame. A region of the frame with no item in it, cut off by a rule
 * that runs from frame side to frame side: a strip along the bottom (a horizontal rule across the
 * sheet) or a column along the right (a vertical rule from top to bottom), or a block in the
 * bottom-right corner (a rule to the right side meeting a rule down to the bottom, neither touching
 * an item). Rules may be drawn as thin filled rectangles. No frame found → nothing.
 */
export function findTitleBlock(vp: VectorPage, W: number, H: number, items: Pick<Item, "bbox">[]): BBox[] {
  type L = { k: number; lo: number; hi: number };
  const thin = vp.fills.filter((f) => Math.min(f[2] - f[0], f[3] - f[1]) <= 8 && Math.max(f[2] - f[0], f[3] - f[1]) >= 40);
  const rules = (horiz: boolean, g: number): L[] => {
    const ps = [
      ...vp.segs.filter((s) => !s.curve && !s.dash && (horiz ? Math.abs(s.a[1] - s.b[1]) <= 1.5 : Math.abs(s.a[0] - s.b[0]) <= 1.5)).map((s) => (horiz ? { k: (s.a[1] + s.b[1]) / 2, lo: Math.min(s.a[0], s.b[0]), hi: Math.max(s.a[0], s.b[0]) } : { k: (s.a[0] + s.b[0]) / 2, lo: Math.min(s.a[1], s.b[1]), hi: Math.max(s.a[1], s.b[1]) })),
      ...thin.filter((f) => (f[2] - f[0] >= f[3] - f[1]) === horiz).map((f) => (horiz ? { k: (f[1] + f[3]) / 2, lo: f[0], hi: f[2] } : { k: (f[0] + f[2]) / 2, lo: f[1], hi: f[3] })),
    ].sort((a, b) => a.k - b.k || a.lo - b.lo);
    const out: L[] = [];
    for (const q of ps) {
      const o = out.find((x) => Math.abs(x.k - q.k) <= 2 && q.lo <= x.hi + g && q.hi >= x.lo - g);
      if (o) (o.lo = Math.min(o.lo, q.lo)), (o.hi = Math.max(o.hi, q.hi));
      else out.push({ ...q });
    }
    return out;
  };
  const hs = rules(true, 0.01 * W), vs = rules(false, 0.01 * H);
  const hf = hs.filter((l) => l.hi - l.lo >= 0.8 * W), vf = vs.filter((l) => l.hi - l.lo >= 0.8 * H);
  if (hf.length < 2) return [];
  const top = Math.min(...hf.map((l) => l.k)), bot = Math.max(...hf.map((l) => l.k));
  const left = vf.length >= 2 ? Math.min(...vf.map((l) => l.k)) : Math.max(...hf.map((l) => l.lo));
  const right = vf.length >= 2 ? Math.max(...vf.map((l) => l.k)) : Math.min(...hf.map((l) => l.hi));
  const fw = right - left, fh = bot - top, e = 0.01 * W;
  if (fw < 0.5 * W || fh < 0.5 * H) return [];
  const ctr = (b: BBox): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const empty = (r: BBox) => !items.some((i) => {
    const c = ctr(i.bbox);
    return c[0] > r[0] && c[0] < r[2] && c[1] > r[1] && c[1] < r[3];
  });
  const touched = (r: BBox) => items.some((i) => i.bbox[0] <= r[2] + 3 && i.bbox[2] >= r[0] - 3 && i.bbox[1] <= r[3] + 3 && i.bbox[3] >= r[1] - 3);
  const out: BBox[] = [];
  for (const l of hs)
    if (l.k > top + 0.6 * fh && l.k < bot - 0.015 * fh && Math.abs(l.lo - left) <= e && Math.abs(l.hi - right) <= e && empty([left, l.k, right, bot])) out.push([left, l.k, right, bot]);
  for (const l of vs)
    if (l.k > left + 0.6 * fw && l.k < right - 0.015 * fw && Math.abs(l.lo - top) <= e && Math.abs(l.hi - bot) <= e && empty([l.k, top, right, bot])) out.push([l.k, top, right, bot]);
  for (const h of hs)
    if (Math.abs(h.hi - right) <= e && h.k > top + 0.5 * fh && h.k < bot - 0.015 * fh)
      for (const v of vs)
        if (Math.abs(v.hi - bot) <= e && v.k > left + 0.4 * fw && v.k < right - 0.05 * fw && Math.abs(v.lo - h.k) <= e && Math.abs(h.lo - v.k) <= e) {
          const r: BBox = [v.k, h.k, right, bot];
          if (empty(r) && !touched([v.k, h.k, v.k, bot]) && !touched([v.k, h.k, right, h.k])) out.push(r);
        }
  return out.map((b) => b.map(Math.round) as BBox);
}

export async function drawNets(file: string, out: string, W: number, H: number, nets: Net[], items: Item[]) {
  const hue = (k: number) => `hsl(${(k * 137) % 360},85%,45%)`;
  const g = nets
    .map(
      (n, k) =>
        n.path.map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${n.dash ? "#0050ff" : hue(k)}" stroke-width="6"${n.dash ? ' stroke-dasharray="18 10"' : ""}/>`).join("") +
        n.touches.map((t) => `<circle cx="${t.at[0]}" cy="${t.at[1]}" r="12" fill="#00b000"/>`).join("") +
        n.ends.map((t) => `<circle cx="${t[0]}" cy="${t[1]}" r="12" fill="#ff8800"/>`).join("") +
        n.attaches.map((t) => `<rect x="${t.at[0] - 10}" y="${t.at[1] - 10}" width="20" height="20" fill="#ff00ff"/>`).join(""),
    )
    .join("");
  const bx = items.map((i) => `<rect x="${i.bbox[0]}" y="${i.bbox[1]}" width="${i.bbox[2] - i.bbox[0]}" height="${i.bbox[3] - i.bbox[1]}" fill="none" stroke="#888" stroke-width="3"/>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="white" fill-opacity="0.6"/>${bx}${g}</svg>`);
  const buf = await sharp(file).composite([{ input: svg }]).png().toBuffer();
  await sharp(buf).resize(Math.round(W * 0.4)).png().toFile(out);
}

// ---------------------------------------------------------------- prompt evidence

/** Solid nets that reach two or more items, in the connect prompt's terms. Pipes are cut at every symbol. */
export function netEvidence(nets: Net[], model: DrawingModel, norm: (x: number, y: number) => string, limit = 400): string {
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const name = (id: string) => {
    const it = byId.get(id);
    return it ? `${id}${it.tag ? `(${it.tag})` : ""}` : id;
  };
  const busy = (n: Net) => n.touches.length > 6;
  const rows: string[] = [];
  for (const n of nets) {
    if (n.touches.length + n.attaches.length < 2 && !(n.touches.length === 1 && n.ends.length)) continue;
    const kind = n.dash ? "dashed" : n.w < pipeWidth(nets) * 0.7 ? "thin" : "pipe";
    const parts = [
      `${n.id} ${kind}${busy(n) ? " (bus/header)" : ""}: ${n.touches.map((t) => name(t.item)).join(", ") || "—"}`,
      n.attaches.length ? `ends on ${n.attaches.map((a) => `${a.net} at ${norm(...a.at)}`).join(", ")}` : "",
      n.ends.length ? `${n.ends.length} loose end(s) at ${n.ends.slice(0, 3).map((e) => norm(...e)).join(" ")}` : "",
    ].filter(Boolean);
    rows.push(parts.join("; "));
    if (rows.length >= limit) break;
  }
  return rows.join("\n");
}

/** Typical pipe stroke: the width carrying most of the solid line length. */
export function pipeWidth(nets: Net[]) {
  const by = new Map<number, number>();
  // only lines that reach a symbol: the frame, title block and legend are not pipes
  const touching = nets.filter((n) => !n.dash && n.touches.length);
  for (const n of touching.length ? touching : nets.filter((x) => !x.dash)) by.set(Math.round(n.w * 2) / 2, (by.get(Math.round(n.w * 2) / 2) ?? 0) + n.len);
  return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
}

// ---------------------------------------------------------------- repair after tracing

const isEnd = (c?: string) => c === "equipment" || c === "off_page";
const onRun = (cat?: string) => cat === "valve" || cat === "piping_component";

/**
 * Close 'open' run ends the geometry settles. From the run's last item, follow the net that does
 * not lead back into the run; walk through items that are on no run yet (valves the tracer missed,
 * appended to the run); stop at equipment / an off-page connector (end point) or at an item of
 * another run (branch). Only a single unambiguous path is taken.
 */
export function closeOpenEnds(model: DrawingModel, netsByPage: Map<number, Net[]>): string[] {
  const notes: string[] = [];
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const runOf = new Map<string, Line>();
  for (const l of model.lines) for (const c of l.components) runOf.set(c, l);
  const endRefs = (l: Line) => [l.from, l.to].filter((e) => e.kind !== "line" && e.ref).map((e) => e.ref!);
  for (const l of model.lines) {
    const nets = netsByPage.get(l.page);
    if (!nets) continue;
    const adj = pipedNeighbours(nets);
    for (const side of ["from", "to"] as const) {
      const end = l[side];
      if (end.kind !== "open") continue;
      const other = side === "from" ? l.to : l.from;
      // drains, vents and exhausts end in the open by design
      const lastIt = byId.get((side === "from" ? l.components[0] : l.components[l.components.length - 1]) ?? "");
      if (/drain|vent|exhaust|atmos|funnel|overflow|silencer|attenuator/i.test(`${l.service ?? ""} ${lastIt?.type ?? ""} ${lastIt?.description ?? ""}`)) continue;
      const seq = side === "from" ? [...l.components].reverse() : [...l.components]; // seq ends at the open side
      let cur = seq[seq.length - 1] ?? (other.kind !== "line" ? other.ref : null);
      if (!cur) continue;
      const visited = new Set<string>([...l.components, ...endRefs(l)]);
      const added: string[] = [];
      let result: Endpoint | null = null;
      for (let step = 0; step < 8 && cur; step++) {
        const back = new Set([...visited]);
        const cands = [...(adj.get(cur)?.keys() ?? [])].filter((x) => !back.has(x) && byId.get(x)?.category !== "instrument");
        if (cands.length !== 1) break;
        const x = cands[0];
        // the drawn line between them must not also run on to a loose end: then the open end is real
        const via = nets.find((n) => n.id === adj.get(cur!)!.get(x));
        if (!via || via.ends.length) break;
        const it = byId.get(x)!;
        if (isEnd(it.category)) {
          result = { kind: it.category === "off_page" ? "off_page" : "equipment", ref: x, after: null };
          break;
        }
        const r = runOf.get(x);
        if (r && other.kind === "line" && other.ref === r.id) break; // back to where it started
        if (r && r !== l) {
          // branch onto run r: it joins between x and its neighbour on r that the same net reaches
          const k = r.components.indexOf(x);
          const net = adj.get(cur)!.get(x)!;
          const mates = (netsByPage.get(l.page) ?? []).find((n) => n.id === net)?.touches.map((t) => t.item) ?? [];
          const prev = r.components[k - 1], next = r.components[k + 1];
          const after = prev && mates.includes(prev) ? prev : next && mates.includes(next) ? x : null;
          if (after === null && !(k === 0 || k === r.components.length - 1)) break;
          result = { kind: "line", ref: r.id, after: after ?? (k === 0 ? null : x) };
          break;
        }
        if (!onRun(it.category) || runOf.has(x)) break;
        added.push(x);
        visited.add(x);
        cur = x;
      }
      if (!result) continue;
      if (added.length) {
        if (side === "to") l.components.push(...added);
        else l.components.unshift(...added.reverse());
        for (const a of added) runOf.set(a, l);
      }
      l[side] = result;
      const label = (id: string | null) => (id ? (byId.get(id)?.tag ?? id) : "?");
      notes.push(`${l.line_id ?? l.id} ${side} → ${result.kind === "line" ? `branch on ${result.ref}` : label(result.ref)}${added.length ? ` (+ ${added.map(label).join(", ")})` : ""}`);
    }
  }
  return notes;
}

/**
 * Drawn pipes the runs leave out. Each solid net is one piece of drawn pipe (cut at every symbol), so
 * all apparatus, valves, components and off-page connectors it reaches are joined on the drawing. When
 * the runs do not join them (directly, or by a branch on the run between them), the missing pipe is
 * added: an open run end that the net reaches is closed onto the other item; otherwise a new run joins
 * the two, as a branch (tee) where it meets a run. Pieces are joined nearest first along the drawn net.
 * Instrument lines and nets reaching more than `maxEnds` items (a busy header the tracer must sort out)
 * are left alone.
 */
export function joinDrawnPipes(model: DrawingModel, netsByPage: Map<number, Net[]>, maxEnds = 10): string[] {
  const notes: string[] = [];
  const byId = new Map(model.items.map((i) => [i.id, i]));
  // motors, drives and panels hang on a mechanical or electrical link, a tie-in flag marks a spot on a pipe:
  // none of them is where a pipe ends
  const notPipeEnd = (i?: Item) => !i || /motor|drive|agitator|panel|cabinet|plc|starter|switch|junction|tie[_ -]?in/i.test(`${i.type ?? ""} ${i.description ?? ""}`);
  const pipeCat = (c?: string) => c === "equipment" || c === "off_page" || c === "valve" || c === "piping_component";
  const label = (id: string) => byId.get(id)?.tag ?? id;
  let seq = Math.max(0, ...model.lines.map((l) => Number(/-(\d+)$/.exec(l.id)?.[1] ?? 0)));
  for (const [page, nets] of netsByPage) {
    // the model's joins between items on this page
    const edges = new Set<string>();
    const join = (a: string | null | undefined, b: string | null | undefined) => {
      if (a && b && a !== b) edges.add([a, b].sort().join("|"));
    };
    const runOf = new Map<string, Line>();
    const members = (l: Line) => [l.from.kind === "equipment" || l.from.kind === "off_page" ? l.from.ref : null, ...l.components, l.to.kind === "equipment" || l.to.kind === "off_page" ? l.to.ref : null].filter((x): x is string => Boolean(x));
    const rebuild = () => {
      edges.clear();
      runOf.clear();
      for (const l of model.lines) {
        for (const c of l.components) runOf.set(c, l);
        const m = members(l);
        for (let k = 1; k < m.length; k++) join(m[k - 1], m[k]);
      }
      for (const l of model.lines)
        for (const side of ["from", "to"] as const) {
          const e = l[side];
          if (e.kind !== "line" || !e.ref) continue;
          const r = model.lines.find((x) => x.id === e.ref);
          if (!r) continue;
          const m = members(l);
          const mine = side === "from" ? m[0] : m[m.length - 1];
          // the tee sits between `after` and the next member of r; at the start: between r's start item
          // (when it has one) and its first component
          const rm = members(r);
          const startsAtItem = r.from.kind === "equipment" || r.from.kind === "off_page";
          const k = e.after ? rm.indexOf(e.after) : startsAtItem ? 0 : -1;
          join(mine, rm[k]);
          join(mine, rm[k + 1]);
        }
    };
    rebuild();
    for (const net of nets) {
      if (net.dash) continue;
      const ends = [...new Set(net.touches.map((t) => t.item))].filter((id) => pipeCat(byId.get(id)?.category) && !notPipeEnd(byId.get(id)) && byId.get(id)?.page === page);
      if (ends.length < 2 || ends.length > maxEnds) continue;
      // groups the model already joins (within this net's items)
      const parent = new Map(ends.map((e) => [e, e]));
      const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
      for (const a of ends) for (const b of ends) if (a < b && edges.has(`${a}|${b}`)) parent.set(find(a), find(b));
      if (new Set(ends.map(find)).size === 1) continue;
      // join the groups, nearest pair first along the drawn net
      const at = (id: string) => net.touches.find((t) => t.item === id)!.at;
      const pairs: [string, string, number][] = [];
      for (const a of ends)
        for (const b of ends) {
          if (a >= b) continue;
          const path = netPath(net, at(a), at(b));
          let L = 0;
          if (path) for (let k = 1; k < path.length; k++) L += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
          pairs.push([a, b, path ? L : Infinity]);
        }
      pairs.sort((x, y) => x[2] - y[2]);
      for (const [a, b, L] of pairs) {
        if (!isFinite(L) || find(a) === find(b)) continue;
        const ia = byId.get(a)!, ib = byId.get(b)!;
        // boxes that touch: the line between them is their shared border (two tag frames side by side)
        const bg = Math.max(0, Math.max(ia.bbox[0], ib.bbox[0]) - Math.min(ia.bbox[2], ib.bbox[2])) + Math.max(0, Math.max(ia.bbox[1], ib.bbox[1]) - Math.min(ia.bbox[3], ib.bbox[3]));
        if (bg <= 3) continue;
        // the drawn end also lies at (overlapping boxes) an item the model already joins to the other side:
        // the net may belong to that one, nothing is proven
        const near = (pt: Pt, id: string) =>
          model.items.filter((i) => i.id !== id && i.page === page && pipeCat(i.category) && pt[0] >= i.bbox[0] - 15 && pt[0] <= i.bbox[2] + 15 && pt[1] >= i.bbox[1] - 15 && pt[1] <= i.bbox[3] + 15).map((i) => i.id);
        const linked = (x: string, y: string) => edges.has([x, y].sort().join("|"));
        if (near(at(b), b).some((c) => linked(c, a)) || near(at(a), a).some((c) => linked(c, b))) continue;
        // two items of one run: their order on it is the tracer's call, a loop of the run onto itself adds nothing
        if (runOf.has(a) && runOf.get(a) === runOf.get(b)) continue;
        // an item on no run yet: placeOrphans' business, not a new run of one pipe
        if (onRun(ia.category) && !runOf.has(a)) continue;
        if (onRun(ib.category) && !runOf.has(b)) continue;
        /** endpoint at item x of the new pipe; tee after x on its run, on the side the net leaves it */
        const ep = (x: string): Endpoint => {
          const it = byId.get(x)!;
          if (it.category === "equipment") return { kind: "equipment", ref: x, after: null };
          if (it.category === "off_page") return { kind: "off_page", ref: x, after: null };
          const r = runOf.get(x)!;
          const k = r.components.indexOf(x);
          const prev = r.components[k - 1];
          return { kind: "line", ref: r.id, after: prev && ends.includes(prev) ? prev : x, at: [Math.round(at(x)[0]), Math.round(at(x)[1])] };
        };
        /** an open run end at x: close it onto y instead of adding a run */
        const closeOpen = (x: string, y: string): boolean => {
          const r = runOf.get(x);
          if (!r) return false;
          const side = r.components[0] === x && r.from.kind === "open" ? "from" : r.components[r.components.length - 1] === x && r.to.kind === "open" ? "to" : null;
          if (!side) return false;
          r[side] = ep(y);
          notes.push(`${r.line_id ?? r.id} ${side} → ${r[side].kind === "line" ? `branch on ${r[side].ref}` : label(y)} (drawn pipe from ${label(x)})`);
          return true;
        };
        if (!closeOpen(a, b) && !closeOpen(b, a)) {
          const id = `L${page}-${String(++seq).padStart(3, "0")}`;
          model.lines.push({ id, page, line_id: null, size: null, spec: null, service: null, from: ep(a), to: ep(b), components: [], insulation: null, confidence: 0.55 });
          notes.push(`${id}: drawn pipe ${label(a)} – ${label(b)}`);
        }
        parent.set(find(a), find(b));
        rebuild();
      }
    }
  }
  return notes;
}

/**
 * Valves and piping components on no run (the tracer skipped them: drain and vent valves next to a
 * traced drain, a valve straight on a tank nozzle) cannot be written to DEXPI. Place each from the
 * pipe nets it touches:
 *  - inline: two of its nets reach two neighbours on one run → inserted between them;
 *  - branch: one net reaches a run → a short run from there (tee on that run, the same tee as a
 *    traced branch whose first valve that net reaches, or the equipment it reaches), through the
 *    component and any further unplaced ones it is piped to alone, to an end point or 'open'.
 * Only places the nets leave one answer for; ambiguous ones stay as they are.
 */
export function placeOrphans(model: DrawingModel, netsByPage: Map<number, Net[]>): string[] {
  const notes: string[] = [];
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const placed = () => new Set(model.lines.flatMap((l) => l.components));
  const usedOpc = new Set(model.lines.flatMap((l) => [l.from, l.to]).filter((e) => e.kind === "off_page" && e.ref).map((e) => e.ref!));
  const label = (id: string | null) => (id ? (byId.get(id)?.tag ?? id) : "?");
  const lineNo = new Map<number, number>();
  for (const l of model.lines) {
    const n = Number(l.id.match(/^L\d+-(\d+)$/)?.[1] ?? 0);
    lineNo.set(l.page, Math.max(lineNo.get(l.page) ?? 0, n));
  }
  const seqOf = (l: Line) => [l.from.kind !== "line" ? l.from.ref : null, ...l.components, l.to.kind !== "line" ? l.to.ref : null];
  const key = (e: Endpoint) => `${e.kind}|${e.ref}|${e.after}`;

  for (const [page, nets] of netsByPage) {
    const solid = nets.filter((n) => !n.dash);
    const netsOf = (id: string) => solid.filter((n) => n.touches.some((t) => t.item === id));
    const orphans = model.items.filter((i) => i.page === page && onRun(i.category) && !placed().has(i.id));
    for (const o of orphans) {
      if (placed().has(o.id)) continue; // taken along by an earlier one
      const mine = netsOf(o.id);
      if (!mine.length || mine.length > 2) continue;
      const others = (n: Net) => n.touches.map((t) => t.item).filter((x) => x !== o.id);

      // inline: one net to a, the other to b, a and b neighbours on one run
      if (mine.length === 2) {
        let done = false;
        for (const l of model.lines.filter((l) => l.page === page)) {
          const seq = seqOf(l);
          for (let k = 1; k < seq.length && !done; k++) {
            const a = seq[k - 1], b = seq[k];
            if (!a || !b) continue;
            const hit = (n: Net, x: string) => others(n).includes(x);
            if ((hit(mine[0], a) && hit(mine[1], b)) || (hit(mine[0], b) && hit(mine[1], a))) {
              l.components.splice(k - 1, 0, o.id); // seq[k] is component k-1 (seq[0] is the start)
              notes.push(`${label(o.id)} inline on ${l.line_id ?? l.id} between ${label(a)} and ${label(b)}`);
              done = true;
            }
          }
          if (done) break;
        }
        if (done) continue;
      }

      // branch: exactly one net leads to placed items; it gives the attachment point
      const runOf = new Map<string, Line>();
      for (const l of model.lines) for (const c of l.components) runOf.set(c, l);
      const isProcessEq = (x: string) => byId.get(x)?.category === "equipment" && !/panel|cabinet|plc|junction|switch|control/i.test(byId.get(x)!.type ?? "");
      const hostNets = mine.filter((n) => others(n).some((x) => runOf.has(x) || isProcessEq(x)));
      if (hostNets.length !== 1) continue;
      const host = hostNets[0];
      const cands = new Map<string, Endpoint>();
      const stubs = new Set<string>(); // tees of traced branches this net reaches
      for (const x of others(host)) {
        if (isProcessEq(x)) {
          cands.set(`equipment|${x}`, { kind: "equipment", ref: x, after: null });
          continue;
        }
        const r = runOf.get(x);
        if (!r) continue;
        const k = r.components.indexOf(x);
        // the stub of a traced branch: hang on the same tee
        if (k === 0 && r.from.kind === "line") { cands.set(key(r.from), { ...r.from }); stubs.add(key(r.from)); continue; }
        if (k === r.components.length - 1 && r.to.kind === "line") { cands.set(key(r.to), { ...r.to }); stubs.add(key(r.to)); continue; }
        // the pipe between x and its neighbour on r
        const prev = r.components[k - 1], next = r.components[k + 1];
        const touched = others(host);
        const after = next && touched.includes(next) ? x : prev && touched.includes(prev) ? prev : x;
        cands.set(`line|${r.id}|${after}`, { kind: "line", ref: r.id, after });
      }
      // a traced branch whose first valve this net reaches: hang on its tee (where the tracer put
      // it, even when the parent item the net reaches suggests a neighbouring spot)
      const all = [...cands.values()];
      const stub = stubs.size === 1 ? cands.get([...stubs][0])! : null;
      const pick = all.length === 1 ? all[0] : stub && all.every((e) => e === stub || (e.kind === "line" && e.ref === stub.ref)) ? stub : null;
      if (!pick) continue;
      // follow on: the component's other net leads to one more unplaced component, an end point, or nothing
      const comps = [o.id];
      let to: Endpoint = { kind: "open", ref: null, after: null };
      let cur = o.id, via = host;
      for (let step = 0; step < 6; step++) {
        const next = netsOf(cur).filter((n) => n !== via);
        if (next.length !== 1) break;
        const ahead = others(next[0]).filter((x) => x !== cur);
        if (ahead.length !== 1) break;
        const it = byId.get(ahead[0]);
        if (it?.category === "equipment" || (it?.category === "off_page" && !usedOpc.has(ahead[0]))) {
          to = { kind: it.category === "off_page" ? "off_page" : "equipment", ref: ahead[0], after: null };
          if (it.category === "off_page") usedOpc.add(ahead[0]);
          break;
        }
        if (!it || !onRun(it.category) || placed().has(ahead[0]) || comps.includes(ahead[0])) break;
        comps.push(ahead[0]);
        cur = ahead[0];
        via = next[0];
      }
      const parent = pick.kind === "line" ? model.lines.find((l) => l.id === pick.ref) : null;
      const n = (lineNo.get(page) ?? 0) + 1;
      lineNo.set(page, n);
      const id = `L${page}-${String(n).padStart(3, "0")}`;
      model.lines.push({
        id,
        page,
        line_id: null,
        size: null,
        spec: null,
        service: parent?.service ?? model.lines.find((l) => l.from.ref === pick.ref || l.to.ref === pick.ref)?.service ?? null,
        from: pick,
        to,
        components: comps,
        insulation: null,
        confidence: 0.6,
      });
      const at = pick.kind === "line" ? `branch on ${parent?.line_id ?? pick.ref}${pick.after ? ` after ${label(pick.after)}` : ""}` : label(pick.ref);
      notes.push(`${comps.map(label).join(" + ")} on a new run ${id} from ${at} to ${to.kind === "open" ? "an open end" : label(to.ref)}`);
    }
  }
  return notes;
}

/**
 * Link instruments that have no signal yet from the drawn lines that leave their bubble: a dashed
 * or thin line to one item or onto a pipe, or a pipe running straight into the bubble (inline
 * instrument). Busy nets (a signal bus / I/O header reaching many bubbles) prove nothing and are skipped.
 */
export function linkByNets(model: DrawingModel, netsByPage: Map<number, Net[]>): string[] {
  const notes: string[] = [];
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const runOf = new Map<string, Line>();
  for (const l of model.lines) {
    for (const c of l.components) runOf.set(c, l);
  }
  const linked = new Set(model.signals.flatMap((s) => [s.instrument, s.target]));
  for (const [page, nets] of netsByPage) {
    const netById = new Map(nets.map((n) => [n.id, n]));
    const runForNet = (n: Net): Line | null => {
      // the run holding the items this pipe net reaches (two neighbours on one run is best)
      const runs = n.touches.map((t) => runOf.get(t.item)).filter((x): x is Line => Boolean(x));
      const count = new Map<Line, number>();
      for (const r of runs) count.set(r, (count.get(r) ?? 0) + 1);
      const best = [...count].sort((a, b) => b[1] - a[1]);
      if (best.length === 1 || (best.length > 1 && best[0][1] > best[1][1])) return best[0][0];
      // a run ending at equipment this net reaches
      return null;
    };
    for (const it of model.items.filter((i) => i.page === page && i.category === "instrument" && !linked.has(i.id))) {
      const found: { kind: "measures" | "actuates" | "signal"; target: string; why: string }[] = [];
      for (const n of nets) {
        if (!n.touches.some((t) => t.item === it.id) || n.touches.length > 4) continue;
        const others = n.touches.map((t) => t.item).filter((x) => x !== it.id);
        if (!n.dash && others.length >= 2 && n.attaches.length === 0) {
          // a pipe through the bubble: inline instrument on that run
          const r = runForNet(n);
          if (r) found.push({ kind: "measures", target: r.id, why: "on the pipe" });
          continue;
        }
        for (const o of others) {
          const t = byId.get(o);
          if (!t) continue;
          const fn = splitInstrumentTag(it.tag).functions;
          if (t.category === "instrument") found.push({ kind: "signal", target: o, why: "line to bubble" });
          else if (t.category === "valve" || (t.category === "equipment" && /[CYKS]/.test(fn) && !/^[ETIGRAL]*$/.test(fn))) found.push({ kind: "actuates", target: o, why: "line to final element" });
          else found.push({ kind: "measures", target: o, why: "line to item" });
        }
        for (const a of n.attaches) {
          const p = netById.get(a.net);
          if (!p || p.dash) continue;
          const r = runForNet(p);
          if (r) found.push({ kind: "measures", target: r.id, why: "tap on pipe" });
          else {
            const eq = p.touches.map((t) => byId.get(t.item)).find((x) => x?.category === "equipment");
            if (eq) found.push({ kind: "measures", target: eq.id, why: "tap on equipment line" });
          }
        }
      }
      const uniq = [...new Map(found.map((f) => [`${f.kind}|${f.target}`, f])).values()];
      if (!uniq.length || uniq.length > 2) continue; // nothing, or too many to be sure
      for (const f of uniq) model.signals.push({ instrument: it.id, kind: f.kind, target: f.target });
      linked.add(it.id);
      const tgt = (id: string) => byId.get(id)?.tag ?? model.lines.find((l) => l.id === id)?.line_id ?? id;
      notes.push(`${it.tag ?? it.id} ${uniq.map((f) => `${f.kind} ${tgt(f.target)}`).join(" + ")}`);
    }
  }
  return notes;
}

/** How well the traced runs agree with the drawn lines: share of neighbour pairs the nets confirm. */
export function netAgreement(model: DrawingModel, netsByPage: Map<number, Net[]>) {
  let pairs = 0, ok = 0;
  const doubt: string[] = [];
  const touched = new Map<number, Set<string>>();
  for (const [p, nets] of netsByPage) touched.set(p, new Set(nets.flatMap((n) => n.touches.map((t) => t.item))));
  for (const l of model.lines) {
    const nets = netsByPage.get(l.page);
    if (!nets) continue;
    const adj = pipedNeighbours(nets);
    const seq = [l.from.kind !== "line" ? l.from.ref : null, ...l.components, l.to.kind !== "line" ? l.to.ref : null].filter((x): x is string => Boolean(x));
    for (let k = 1; k < seq.length; k++) {
      const a = seq[k - 1], b = seq[k];
      if (!touched.get(l.page)!.has(a) || !touched.get(l.page)!.has(b)) continue; // no geometry for one of them
      pairs++;
      if (adj.get(a)?.has(b)) ok++;
      else doubt.push(`${l.id}: ${a} → ${b}`);
    }
  }
  return { pairs, ok, share: pairs ? +(ok / pairs).toFixed(3) : null, doubt };
}

// ---------------------------------------------------------------- signal lines as objects

/** The run holding the items a pipe net reaches (most items on one run wins). */
function runOfNet(n: Net, runOf: Map<string, Line>): Line | null {
  const count = new Map<Line, number>();
  for (const t of n.touches) {
    const r = runOf.get(t.item);
    if (r) count.set(r, (count.get(r) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1]);
  return best.length === 1 || (best.length > 1 && best[0][1] > best[1][1]) ? best[0][0] : null;
}

/**
 * Drawn signal and instrument lines as objects of their own: every dashed net, and every thin solid
 * net that reaches an instrument bubble. Type from the ISA 5.1 line pattern:
 *   - - -  electrical · -·-·  software / data link · —//—  pneumatic · —x—  capillary ·
 *   thin solid  process connection (impulse line).
 * A line reaching more than four bubbles is a bus. Signals between the same ends get its id ('via').
 */
export function buildSignalLines(model: DrawingModel, netsByPage: Map<number, Net[]>): SignalLine[] {
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const runOf = new Map<string, Line>();
  for (const l of model.lines) for (const c of l.components) runOf.set(c, l);
  const out: SignalLine[] = [];
  for (const [page, nets] of netsByPage) {
    const pw = pipeWidth(nets);
    const netById = new Map(nets.map((n) => [n.id, n]));
    let k = 0;
    for (const n of nets) {
      const instruments = n.touches.filter((t) => byId.get(t.item)?.category === "instrument");
      const thin = !n.dash && n.w < 0.75 * pw;
      if (!instruments.length || (!n.dash && !thin)) continue;
      // a single dash beside one bubble (a stub, a fragment of its symbol) is no line of its own
      const W = model.pages.find((pg) => pg.n === page)?.px[0] ?? 5000;
      if (n.touches.length <= 1 && n.len < 0.006 * W) continue;
      // the outline of the instrument's own symbol (a shared-display square around the bubble): it
      // surrounds the one bubble it touches on three or more sides and stays within a bubble's size of it
      if (!n.dash && n.touches.length === 1) {
        const b = byId.get(n.touches[0].item)!.bbox, sz = Math.max(b[2] - b[0], b[3] - b[1]), m = 0.15 * sz;
        const sides = [n.bbox[0] < b[0] - m, n.bbox[1] < b[1] - m, n.bbox[2] > b[2] + m, n.bbox[3] > b[3] + m].filter(Boolean).length;
        if (sides >= 3 && n.bbox[0] >= b[0] - sz && n.bbox[1] >= b[1] - sz && n.bbox[2] <= b[2] + sz && n.bbox[3] <= b[3] + sz) continue;
      }
      const m = n.marks.pos + n.marks.neg;
      const type: SignalLineType =
        n.pattern === "dashdot" ? "software"
        : n.dash ? "electrical"
        : m >= 2 && Math.min(n.marks.pos, n.marks.neg) >= 1 && Math.abs(n.marks.pos - n.marks.neg) <= Math.max(1, m / 3) ? "capillary"
        : m >= 2 ? "pneumatic"
        : "process_connection";
      const ends: SignalLine["ends"] = n.touches.map((t) => ({ item: t.item, at: t.at }));
      for (const a of n.attaches) {
        const p = netById.get(a.net);
        if (!p || p.dash) continue;
        const r = runOfNet(p, runOf);
        const eq = p.touches.map((t) => byId.get(t.item)).find((x) => x?.category === "equipment");
        ends.push(r ? { line: r.id, at: a.at } : eq ? { item: eq.id, at: a.at } : { at: a.at });
      }
      for (const e of n.ends) ends.push({ at: e });
      out.push({ id: `SL${page}.${++k}`, page, type, pattern: n.pattern, bus: instruments.length > 4, ends, path: n.path, length: n.len });
    }
  }
  // signals carried by a drawn line: both ends on it (a bus carries every signal between its bubbles)
  for (const s of model.signals) {
    const sl = out.find((x) => x.ends.some((e) => e.item === s.instrument) && x.ends.some((e) => e.item === s.target || e.line === s.target));
    if (sl) s.via = sl.id;
    else delete s.via;
  }
  return out;
}

/**
 * Exact pipe routes for every pair of neighbours on a traced run that one pipe net joins: the
 * DEXPI drawing layer draws these instead of a one-bend guess.
 */
export function pipeRoutes(model: DrawingModel, netsByPage: Map<number, Net[]>): PipeRoute[] {
  const out: PipeRoute[] = [];
  const seen = new Set<string>();
  for (const l of model.lines) {
    const nets = netsByPage.get(l.page);
    if (!nets) continue;
    const adj = pipedNeighbours(nets);
    const byNet = new Map(nets.map((n) => [n.id, n]));
    const seq = [l.from.kind !== "line" ? l.from.ref : null, ...l.components, l.to.kind !== "line" ? l.to.ref : null].filter((x): x is string => Boolean(x));
    for (let k = 1; k < seq.length; k++) {
      const a = seq[k - 1], b = seq[k];
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      const net = byNet.get(adj.get(a)?.get(b) ?? "");
      if (!net) continue;
      const ta = net.touches.find((t) => t.item === a)!, tb = net.touches.find((t) => t.item === b)!;
      const pts = netPath(net, ta.at, tb.at);
      if (!pts || pts.length < 2) continue;
      seen.add(key);
      out.push({ page: l.page, a, b, pts });
    }
  }
  return out;
}

/**
 * Where each 'measures' link meets its pipe: the line leaving the bubble (impulse line, thin or
 * dashed, not a bus) that ends on a pipe net reaching the measured run or item. Sets signal.at.
 */
export function tapPoints(model: DrawingModel, netsByPage: Map<number, Net[]>): number {
  let n = 0;
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const members = new Map<string, Set<string>>();
  for (const l of model.lines) members.set(l.id, new Set([l.from.kind !== "line" ? l.from.ref : null, ...l.components, l.to.kind !== "line" ? l.to.ref : null].filter((x): x is string => Boolean(x))));
  for (const s of model.signals) {
    delete s.at;
    if (s.kind !== "measures") continue;
    const it = byId.get(s.instrument);
    const nets = it ? netsByPage.get(it.page) : undefined;
    if (!it || !nets) continue;
    const want = members.get(s.target) ?? new Set([s.target]);
    const byNet = new Map(nets.map((x) => [x.id, x]));
    const c: Pt = [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2];
    let best: Pt | null = null, bd = Infinity;
    for (const net of nets) {
      if (!net.touches.some((t) => t.item === it.id) || net.touches.length > 3) continue;
      for (const a of net.attaches) {
        const pipe = byNet.get(a.net);
        if (!pipe || pipe.dash || !pipe.touches.some((t) => want.has(t.item))) continue;
        const d = Math.hypot(a.at[0] - c[0], a.at[1] - c[1]);
        if (d < bd) [best, bd] = [a.at, d];
      }
    }
    if (!best) {
      // no line ending on the pipe (a stub ending at a thermowell mark, a bubble straight on its root
      // valve): the nearest point of the measured pipe, seen from the stub's loose end or the bubble
      const r = Math.max(it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1]) / 2;
      const stubEnd = nets
        .filter((x) => x.touches.length === 1 && x.touches[0].item === it.id && x.ends.length)
        .flatMap((x) => x.ends)
        .sort((a, b) => Math.hypot(b[0] - c[0], b[1] - c[1]) - Math.hypot(a[0] - c[0], a[1] - c[1]))[0];
      const from = stubEnd ?? c;
      for (const pipe of nets) {
        if (pipe.dash || !pipe.touches.some((t) => want.has(t.item))) continue;
        for (const [a, b] of pipe.path) {
          const q = nearestOnSeg(from, a, b);
          const d = Math.hypot(q[0] - from[0], q[1] - from[1]);
          if (d < bd) [best, bd] = [q, d];
        }
      }
      if (best && bd > Math.max(6 * r, 60)) best = null;
    }
    if (best) {
      s.at = [Math.round(best[0]), Math.round(best[1])];
      n++;
    }
  }
  return n;
}

/**
 * Nozzle names printed beside an apparatus (S1…S4, T1…T4, N3, A2): the run end at the equipment gets
 * the name printed next to the point where its drawn pipe meets the outline. Only when it is beyond
 * doubt: the pipe is the one that also reaches the run's neighbouring component, the word is the
 * nearest nozzle-like word to that point and that point is the nearest connection to the word, and
 * no two runs of the apparatus get the same name from different points.
 */
export function nozzleLabels(ctx: RunContext, model: DrawingModel, pages: { n: number; W: number; H: number }[], netsByPage: Map<number, Net[]>): string[] {
  const v = loadVector(ctx, pages);
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const NOZ = /^(?:[A-Z]{1,2}\d{1,2}[A-Z]?|N\d{1,3}[A-Z]?)$/;
  type End = { e: Endpoint; eq: Item; at: Pt };
  const ends: End[] = [];
  for (const l of model.lines)
    for (const side of ["from", "to"] as const) {
      const e = l[side];
      delete e.nozzle;
      const eq = e.kind === "equipment" && e.ref ? byId.get(e.ref) : undefined;
      if (!eq || eq.category !== "equipment") continue;
      const nets = netsByPage.get(eq.page);
      if (!nets) continue;
      const other = side === "from" ? l.to : l.from;
      const nb = (side === "from" ? l.components[0] : l.components[l.components.length - 1]) ?? (other.kind !== "line" ? other.ref : null);
      if (!nb) continue;
      const hits = nets.filter((x) => !x.dash && x.touches.some((t) => t.item === nb) && x.touches.some((t) => t.item === eq.id));
      if (hits.length !== 1) continue;
      // the points where this net meets the outline; when the net branches (flange ticks, a header)
      // the run's own nozzle is the one the drawn pipe reaches first from the neighbour, by a clear margin
      const b = eq.bbox;
      const gap = (q: Pt) => Math.hypot(Math.max(b[0] - q[0], 0, q[0] - b[2]), Math.max(b[1] - q[1], 0, q[1] - b[3]));
      const net = hits[0];
      // (an arrowhead or flange drawn at the nozzle can stop the line short of the outline: its touch point counts)
      const touch = net.touches.find((t) => t.item === eq.id)!.at;
      const pts: Pt[] = [touch];
      for (const q of net.path.flat() as Pt[]) if (gap(q) <= 6 && !pts.some((r) => Math.hypot(r[0] - q[0], r[1] - q[1]) <= 6)) pts.push(q);
      if (!pts.length) continue;
      if (pts.length === 1) {
        ends.push({ e, eq, at: pts[0] });
        continue;
      }
      const from = net.touches.find((t) => t.item === nb)!.at;
      const dist = netDistances(net.path as [Pt, Pt][], from);
      const ranked = pts.map((q) => ({ q, d: dist(q) })).sort((x, y) => x.d - y.d);
      if (!isFinite(ranked[0].d) || ranked[0].d > 0.6 * ranked[1].d) continue;
      ends.push({ e, eq, at: ranked[0].q });
    }
  const notes: string[] = [];
  for (const pg of pages) {
    const vp = v.get(pg.n);
    if (!vp || vp.kind !== "vector") continue;
    const here = ends.filter((x) => x.eq.page === pg.n);
    if (!here.length) continue;
    const others = model.items.filter((i) => i.page === pg.n && i.category !== "equipment");
    const words = vp.words
      .filter((w) => NOZ.test(w.text.trim()))
      .filter((w) => {
        const c: Pt = [(w.box[0] + w.box[2]) / 2, (w.box[1] + w.box[3]) / 2];
        // part of a printed tag (a valve or instrument label) is not a nozzle name
        return !others.some((i) => c[0] >= i.bbox[0] && c[0] <= i.bbox[2] && c[1] >= i.bbox[1] && c[1] <= i.bbox[3]);
      })
      .map((w) => ({ text: w.text.trim(), c: [(w.box[0] + w.box[2]) / 2, (w.box[1] + w.box[3]) / 2] as Pt, h: Math.min(w.box[2] - w.box[0], w.box[3] - w.box[1]) }));
    const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const got = new Map<End, string>();
    for (const x of here) {
      const reach = Math.max(45, 4 * (words[0]?.h ?? 12));
      const near = words.filter((w) => d(w.c, x.at) <= reach).sort((a, b) => d(a.c, x.at) - d(b.c, x.at));
      const w = near[0];
      if (!w) continue;
      // a second candidate almost as near: ambiguous
      if (near[1] && near[1].text !== w.text && d(near[1].c, x.at) < 1.3 * d(w.c, x.at)) continue;
      // the word must be nearest to this connection, not to another one
      const closer = ends.some((y) => y !== x && y.eq.page === pg.n && d(y.at, x.at) > 4 && d(w.c, y.at) < d(w.c, x.at));
      if (closer) continue;
      got.set(x, w.text);
    }
    // one name per point of an apparatus
    for (const [x, name] of got) {
      const clash = [...got].some(([y, n2]) => y !== x && y.eq === x.eq && n2 === name && d(y.at, x.at) > 4);
      if (clash) continue;
      x.e.nozzle = name;
      notes.push(`${x.eq.tag ?? x.eq.id}.${name}`);
    }
  }
  return notes;
}

/** Shortest distance along a net's drawn pieces from point `from` to any point (pieces meeting end to end or in a T). */
function netDistances(path: [Pt, Pt][], from: Pt): (q: Pt) => number {
  const key = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const nodes = new Map<string, Pt>();
  for (const [a, b] of path) for (const p of [a, b]) nodes.set(key(p), p);
  nodes.set(key(from), from);
  const adj = new Map<string, { k: string; w: number }[]>();
  const link = (p: Pt, q: Pt) => {
    const w = Math.hypot(p[0] - q[0], p[1] - q[1]);
    for (const [x, y] of [[p, q], [q, p]]) adj.set(key(x), [...(adj.get(key(x)) ?? []), { k: key(y), w }]);
  };
  const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 2;
  for (const [a, b] of path) {
    // every node lying on this piece (ends of other pieces in a T, crossings at a flange tick) splits it
    const on = [...nodes.values()].filter((p) => {
      const q = nearestOnSeg(p, a, b);
      return near(p, q);
    });
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    on.sort((p, q) => ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L - ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / L);
    for (let i = 1; i < on.length; i++) link(on[i - 1], on[i]);
  }
  // nodes within 2 px of each other are one point
  const all = [...nodes.values()];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (near(all[i], all[j])) link(all[i], all[j]);
  const dist = new Map<string, number>([[key(from), 0]]);
  const todo = new Set<string>([key(from)]);
  while (todo.size) {
    let k = "", best = Infinity;
    for (const t of todo) if (dist.get(t)! < best) [k, best] = [t, dist.get(t)!];
    todo.delete(k);
    for (const e of adj.get(k) ?? []) {
      const nd = best + e.w;
      if (nd < (dist.get(e.k) ?? Infinity)) {
        dist.set(e.k, nd);
        todo.add(e.k);
      }
    }
  }
  return (q: Pt) => dist.get(key(q)) ?? Infinity;
}

function nearestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Signal lines + pipe routes into the model (vector pages only; a scan keeps neither). */
export function applyGeometry(model: DrawingModel, netsByPage: Map<number, Net[]>) {
  if (!netsByPage.size) {
    delete model.signal_lines;
    delete model.pipe_routes;
    for (const s of model.signals) delete s.at;
    return { signalLines: 0, routes: 0, carried: 0, taps: 0 };
  }
  model.signal_lines = buildSignalLines(model, netsByPage);
  model.pipe_routes = pipeRoutes(model, netsByPage);
  const taps = tapPoints(model, netsByPage);
  return { signalLines: model.signal_lines.length, routes: model.pipe_routes.length, carried: model.signals.filter((s) => s.via).length, taps };
}

export type { Net, Pt };
