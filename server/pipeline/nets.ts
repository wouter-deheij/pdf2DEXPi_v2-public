import type { BBox, Item } from "../types.ts";
import type { Seg, VectorPage } from "./vector.ts";

/**
 * Nets: the drawn lines of a vector page grouped into connected pieces, with the items they reach.
 * Symbol geometry (everything inside one item's box) is taken out first, so a pipe stops at the
 * valve it runs into: a valve on a run then sits between two nets. Separate dashes are rebuilt into
 * dashed lines (signal / impulse lines). Lines of another width or dash style never merge; where one
 * ends on the other it is recorded as an attachment (a signal line ending on a pipe).
 */

export type Pt = [number, number];
export interface Net {
  id: string;
  page: number;
  dash: boolean;
  w: number; // length-weighted stroke width, px
  len: number;
  segs: number;
  bbox: BBox;
  touches: { item: string; at: Pt }[];
  attaches: { net: string; at: Pt }[];
  ends: Pt[]; // loose ends that reach no item and no other line
  path: Pt[][]; // the segments, for drawing
  /** line pattern: solid, dashed (- - -) or dash-dot (-·-·) */
  pattern: "solid" | "dash" | "dashdot";
  /** short diagonal strokes across the line: '//' marks (pneumatic) lean one way, 'x' marks (capillary) both */
  marks: { pos: number; neg: number };
}

interface S {
  a: Pt;
  b: Pt;
  w: number;
  dash: boolean;
  pattern?: "dash" | "dashdot";
}

const len = (s: { a: Pt; b: Pt }) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
function distPtSeg(p: Pt, s: { a: Pt; b: Pt }) {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (s.a[0] + t * dx), p[1] - (s.a[1] + t * dy));
}
const inBox = (p: Pt, b: BBox, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
const boxDist = (p: Pt, b: BBox) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));
const sameClass = (x: S, y: S) => x.dash === y.dash && Math.max(x.w, y.w) <= 1.35 * Math.max(0.1, Math.min(x.w, y.w)) + 0.3;

/** Rebuild dashed lines from separate short, collinear, evenly spaced pieces (horizontal / vertical). */
function rebuildDashes(short: Seg[], maxGap: number, blocked: (p: Pt) => boolean, minPieces = 4): { dashed: S[]; used: Set<Seg> } {
  const used = new Set<Seg>();
  const dashed: S[] = [];
  for (const horiz of [true, false]) {
    const ax = horiz ? 0 : 1, cr = horiz ? 1 : 0;
    const pieces = short
      .filter((s) => Math.abs(s.a[cr] - s.b[cr]) < 0.8)
      .map((s) => ({ s, c: (s.a[cr] + s.b[cr]) / 2, lo: Math.min(s.a[ax], s.b[ax]), hi: Math.max(s.a[ax], s.b[ax]) }))
      .sort((p, q) => p.c - q.c || p.lo - q.lo);
    // group by cross coordinate (within 1 px), then chain along the axis
    let k = 0;
    while (k < pieces.length) {
      let j = k + 1;
      while (j < pieces.length && pieces[j].c - pieces[k].c < 1.2) j++;
      const row = pieces.slice(k, j).sort((p, q) => p.lo - q.lo);
      let chain: typeof row = [];
      const flush = () => {
        if (chain.length >= minPieces) {
          const seq = chain.map((p) => p.hi - p.lo);
          const lens = [...seq].sort((x, y) => x - y);
          const even = (a: number[]) => a.length > 0 && Math.max(...a) <= 2.2 * Math.max(1, Math.min(...a));
          const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
          const regular = lens[lens.length - 1] <= 2.5 * Math.max(1, lens[0]);
          // dash-dot: long and short pieces take turns, each kind regular
          const A = seq.filter((_, i) => i % 2 === 0), B = seq.filter((_, i) => i % 2 === 1);
          const dashdot = !regular && even(A) && even(B) && Math.max(mean(A), mean(B)) >= 2.5 * Math.min(mean(A), mean(B));
          if (regular || dashdot) {
            const c = chain.reduce((a, p) => a + p.c, 0) / chain.length;
            const lo = chain[0].lo, hi = Math.max(...chain.map((p) => p.hi));
            const w = chain.reduce((a, p) => a + p.s.w, 0) / chain.length;
            dashed.push({ a: horiz ? [lo, c] : [c, lo], b: horiz ? [hi, c] : [c, hi], w, dash: true, pattern: dashdot ? "dashdot" : "dash" });
            for (const p of chain) used.add(p.s);
          }
        }
        chain = [];
      };
      for (const p of row) {
        if (!chain.length) chain.push(p);
        else {
          const last = chain[chain.length - 1];
          const gap = p.lo - last.hi;
          const dl = Math.max(p.hi - p.lo, last.hi - last.lo);
          const mid: Pt = horiz ? [(last.hi + p.lo) / 2, p.c] : [p.c, (last.hi + p.lo) / 2];
          if (gap > 0.3 && gap <= Math.max(maxGap, 1.3 * dl) && Math.abs(p.s.w - last.s.w) < 0.5 && !blocked(mid)) chain.push(p);
          else if (gap <= 0.3) {
            flush(); // touching pieces: a solid line drawn in parts, not dashes
            chain.push(p);
          } else {
            flush();
            chain.push(p);
          }
        }
      }
      flush();
      k = j;
    }
  }
  return { dashed, used };
}

/** Is the nearest point of t straight ahead of end e (0 = a, 1 = b) of s? */
function ahead(s: S, e: number, p: Pt, t: { a: Pt; b: Pt }) {
  const q = e === 0 ? s.b : s.a;
  const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
  const u: Pt = [(p[0] - q[0]) / L, (p[1] - q[1]) / L];
  const dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1];
  const L2 = dx * dx + dy * dy;
  const k = L2 ? Math.max(0, Math.min(1, ((p[0] - t.a[0]) * dx + (p[1] - t.a[1]) * dy) / L2)) : 0;
  const v: Pt = [t.a[0] + k * dx - p[0], t.a[1] + k * dy - p[1]];
  return Math.abs(u[0] * v[1] - u[1] * v[0]) <= 2 + s.w && u[0] * v[0] + u[1] * v[1] >= -1;
}

/** A short piece lying on a rebuilt dashed line (same row, inside its span). */
function onDash(s: Seg, d: S) {
  const horiz = Math.abs(d.a[1] - d.b[1]) < 1;
  const ax = horiz ? 0 : 1, cr = horiz ? 1 : 0;
  const lo = Math.min(d.a[ax], d.b[ax]) - 0.5, hi = Math.max(d.a[ax], d.b[ax]) + 0.5;
  return Math.abs((s.a[cr] + s.b[cr]) / 2 - d.a[cr]) < 1.3 && Math.min(s.a[ax], s.b[ax]) >= lo && Math.max(s.a[ax], s.b[ax]) <= hi;
}

class Grid {
  cells = new Map<string, number[]>();
  constructor(public size: number) {}
  private key(i: number, j: number) {
    return `${i},${j}`;
  }
  add(id: number, b: BBox) {
    for (let i = Math.floor(b[0] / this.size); i <= Math.floor(b[2] / this.size); i++)
      for (let j = Math.floor(b[1] / this.size); j <= Math.floor(b[3] / this.size); j++) {
        const k = this.key(i, j);
        const c = this.cells.get(k);
        if (c) c.push(id);
        else this.cells.set(k, [id]);
      }
  }
  near(p: Pt, r: number): Set<number> {
    const out = new Set<number>();
    for (let i = Math.floor((p[0] - r) / this.size); i <= Math.floor((p[0] + r) / this.size); i++)
      for (let j = Math.floor((p[1] - r) / this.size); j <= Math.floor((p[1] + r) / this.size); j++) for (const id of this.cells.get(this.key(i, j)) ?? []) out.add(id);
    return out;
  }
}

export interface NetOptions {
  /** items whose boxes cut symbol geometry and that lines can reach (same page) */
  items: Pick<Item, "id" | "bbox" | "category">[];
  /** regions to ignore entirely (title block, legend) */
  ignore?: BBox[];
}

export function buildNets(vp: VectorPage, W: number, opt: NetOptions): Net[] {
  const L0 = 0.006 * W; // shortest piece that is surely not lettering
  const mIn = 0.0012 * W; // box margin for symbol geometry
  const mTouch = 0.004 * W; // how far a loose end may stop short of an item box
  const maxGap = 0.004 * W; // largest gap between two dashes
  const boxes = opt.items.map((i) => ({ id: i.id, b: i.bbox, cat: i.category, area: (i.bbox[2] - i.bbox[0]) * (i.bbox[3] - i.bbox[1]) }));
  const ignored = (p: Pt) => (opt.ignore ?? []).some((b) => inBox(p, b));
  // an equipment box holding a valve and at least one more item is a container (vessel with internal
  // piping, skid): the piping drawn inside it is process, not symbol geometry
  const ctr = (b: BBox): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const container = new Set(
    boxes
      .filter((x) => {
        if (x.cat !== "equipment") return false;
        const held = boxes.filter((y) => y !== x && y.cat !== "equipment" && y.area < x.area && inBox(ctr(y.b), x.b));
        return held.length >= 2 && held.some((y) => y.cat === "valve");
      })
      .map((x) => x.id),
  );
  const symbols = boxes.filter((x) => !container.has(x.id));

  // 1. straight pieces outside symbols
  const straight = vp.segs.filter((s) => !s.curve && !ignored(s.a) && !ignored(s.b));
  const outside = straight.filter((s) => !symbols.some((x) => inBox(s.a, x.b, mIn) && inBox(s.b, x.b, mIn)));
  // 2. dashes → dashed lines
  const shortSolid = outside.filter((s) => !s.dash && len(s) < 3 * L0);
  const blockedAt = (p: Pt) => symbols.some((x) => inBox(p, x.b));
  const { dashed, used } = rebuildDashes(shortSolid, maxGap, blockedAt);
  // a short dashed leg (2–3 dashes, e.g. from a bubble up to the corner) continues a dashed line
  const rest = rebuildDashes(shortSolid.filter((s) => !used.has(s)), maxGap, blockedAt, 2);
  const corners = dashed.flatMap((d) => [d.a, d.b]);
  for (let round = 0; round < 3; round++) {
    let grew = false;
    for (const d of rest.dashed) {
      if (dashed.includes(d)) continue;
      if (![d.a, d.b].some((p) => corners.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1.5 * maxGap))) continue;
      dashed.push(d);
      corners.push(d.a, d.b);
      grew = true;
    }
    if (!grew) break;
  }
  for (const d of dashed) if (rest.dashed.includes(d)) for (const sg of shortSolid) if (!used.has(sg) && onDash(sg, d)) used.add(sg);
  const all: S[] = [...outside.filter((s) => !used.has(s)).map((s) => ({ a: s.a, b: s.b, w: s.w, dash: s.dash, pattern: s.dash ? ("dash" as const) : undefined })), ...dashed];

  // 3. union pieces of one class that meet (end to end, or end on another piece: a tee)
  const grid = new Grid(Math.max(32, 0.01 * W));
  all.forEach((s, i) => grid.add(i, [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])]));
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  };
  const tolOf = (s: S) => (s.dash ? 1.5 * maxGap : 1.5 + s.w);
  // per endpoint: does it meet a piece of the same class, and which other-class pieces it ends on
  const meets: { same: boolean; other: number[] }[][] = all.map(() => [
    { same: false, other: [] },
    { same: false, other: [] },
  ]);
  all.forEach((s, i) => {
    [s.a, s.b].forEach((p, e) => {
      const tol = tolOf(s);
      for (const j of grid.near(p, tol)) {
        if (j === i) continue;
        const t = all[j];
        const d = distPtSeg(p, t);
        if (sameClass(s, t)) {
          // a joint across a gap (dashes) must lie straight ahead of this end, not beside it:
          // a parallel line a few px away is no continuation
          const tight = d <= 1.5 + Math.max(s.w, t.w);
          if (d <= Math.max(tol, tolOf(t)) && (tight || ahead(s, e, p, t))) {
            union(i, j);
            meets[i][e].same = true;
          }
        } else if (d <= 1.5 + Math.max(s.w, t.w)) meets[i][e].other.push(j);
      }
    });
  });

  // 3b. a pipe drawn with a break where another line crosses it is one pipe: bridge the break
  const loose: { i: number; e: number; p: Pt; dir: Pt }[] = [];
  all.forEach((s, i) => {
    if (s.dash) return;
    [s.a, s.b].forEach((p, e) => {
      if (meets[i][e].same || meets[i][e].other.length) return;
      if (boxes.some((x) => boxDist(p, x.b) <= mTouch)) return; // ends at a symbol
      const q = e === 0 ? s.b : s.a;
      const L = len(s) || 1;
      loose.push({ i, e, p, dir: [(p[0] - q[0]) / L, (p[1] - q[1]) / L] });
    });
  });
  const looseGrid = new Grid(Math.max(32, 0.01 * W));
  loose.forEach((x, k) => looseGrid.add(k, [x.p[0], x.p[1], x.p[0], x.p[1]]));
  const bridgeMax = 0.008 * W; // a break at a crossing
  const labelMax = 0.06 * W; // a break that holds the line's label or a flow arrow
  const texts: BBox[] = [...vp.words.map((w) => w.box), ...vp.fills.filter((f) => f[2] - f[0] < 0.03 * W && f[3] - f[1] < 0.03 * W)];
  for (const [k, x] of loose.entries()) {
    for (const m of looseGrid.near(x.p, labelMax)) {
      if (m <= k) continue;
      const y = loose[m];
      const s = all[x.i], t = all[y.i];
      if (!sameClass(s, t)) continue;
      const v: Pt = [y.p[0] - x.p[0], y.p[1] - x.p[1]];
      const d = Math.hypot(v[0], v[1]);
      if (d < 1 || d > labelMax) continue;
      const along = v[0] * x.dir[0] + v[1] * x.dir[1];
      const perp = Math.abs(v[0] * x.dir[1] - v[1] * x.dir[0]);
      const facing = x.dir[0] * y.dir[0] + x.dir[1] * y.dir[1] < -0.98;
      if (along <= 0 || perp > 1.5 + s.w || !facing) continue;
      // something must sit in the gap — a crossing line, the line's own label, a flow arrow — or it
      // is a real end (a drain, a cap). A symbol in the gap is not bridged: the line stops at it.
      const mid: Pt = [(x.p[0] + y.p[0]) / 2, (x.p[1] + y.p[1]) / 2];
      const crossed = d <= bridgeMax && [...grid.near(mid, d)].some((j) => j !== x.i && j !== y.i && segsCross(x.p, y.p, all[j].a, all[j].b));
      const r = 2 + s.w;
      const corridor: BBox = [Math.min(x.p[0], y.p[0]) - r, Math.min(x.p[1], y.p[1]) - r, Math.max(x.p[0], y.p[0]) + r, Math.max(x.p[1], y.p[1]) + r];
      const hits = (b: BBox) => b[0] <= corridor[2] && b[2] >= corridor[0] && b[1] <= corridor[3] && b[3] >= corridor[1];
      const labelled = d <= labelMax && (texts.some(hits) || [...grid.near(mid, d / 2 + r)].filter((j) => j !== x.i && j !== y.i && len(all[j]) < L0 && segHitsBox(all[j].a, all[j].b, corridor)).length >= 3);
      if (!crossed && !labelled) continue;
      if (boxes.some((b) => segHitsBox(x.p, y.p, b.b))) continue;
      union(x.i, y.i);
      meets[x.i][x.e].same = true;
      meets[y.i][y.e].same = true;
    }
  }

  // 4. collect nets
  const groups = new Map<number, number[]>();
  all.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  const nets: Net[] = [];
  const netOf = new Map<number, string>();
  let n = 0;
  for (const [, ids] of groups) {
    const ss = ids.map((i) => all[i]);
    const total = ss.reduce((a, s) => a + len(s), 0);
    const longest = Math.max(...ss.map(len));
    if (longest < L0 && !ss[0].dash) continue; // lettering, hatching, small symbol bits
    const id = `${ss[0].dash ? "D" : "N"}${vp.n}.${++n}`;
    for (const i of ids) netOf.set(i, id);
    const xs = ss.flatMap((s) => [s.a[0], s.b[0]]), ys = ss.flatMap((s) => [s.a[1], s.b[1]]);
    nets.push({
      id,
      page: vp.n,
      dash: ss[0].dash,
      w: +(ss.reduce((a, s) => a + s.w * len(s), 0) / Math.max(1, total)).toFixed(2),
      len: Math.round(total),
      segs: ss.length,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round) as BBox,
      touches: [],
      attaches: [],
      ends: [],
      path: ss.map((s) => [s.a.map(Math.round) as Pt, s.b.map(Math.round) as Pt]),
      pattern: !ss[0].dash ? "solid" : ss.filter((s) => s.pattern === "dashdot").reduce((a, s) => a + len(s), 0) > total / 2 ? "dashdot" : "dash",
      marks: { pos: 0, neg: 0 },
    });
  }
  const byId = new Map(nets.map((x) => [x.id, x]));

  // 5. loose ends: on another line (attachment), at an item (touch), or open
  all.forEach((s, i) => {
    const net = byId.get(netOf.get(i) ?? "");
    if (!net) return;
    [s.a, s.b].forEach((p, e) => {
      const m = meets[i][e];
      if (m.same) return;
      const other = m.other.map((j) => netOf.get(j)).find((x) => x && x !== net.id);
      // nearest item box (a point inside a box counts as distance 0; prefer the smaller box)
      let best: { id: string; d: number; area: number } | null = null;
      for (const x of boxes) {
        const d = boxDist(p, x.b);
        if (d > (x.cat === "equipment" ? 2 * mTouch : mTouch)) continue;
        if (!best || d < best.d - 1 || (Math.abs(d - best.d) <= 1 && x.area < best.area)) best = { id: x.id, d, area: x.area };
      }
      const at: Pt = [Math.round(p[0]), Math.round(p[1])];
      if (best) {
        if (!net.touches.some((t) => t.item === best!.id)) net.touches.push({ item: best.id, at });
      } else if (other) {
        if (!net.attaches.some((t) => t.net === other)) net.attaches.push({ net: other, at });
      } else net.ends.push(at);
    });
  });
  // marks across a line: short diagonal strokes (not part of any net) that cross one of its pieces
  for (const [i, s] of all.entries()) {
    if (netOf.has(i) || s.dash) continue;
    const L = len(s);
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (L > L0 || Math.abs(dx) < 0.3 * L || Math.abs(dy) < 0.3 * L) continue; // short and diagonal only
    for (const j of grid.near([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], L)) {
      const net = byId.get(netOf.get(j) ?? "");
      if (!net || !segsCross(s.a, s.b, all[j].a, all[j].b)) continue;
      if (dx * dy > 0) net.marks.pos++;
      else net.marks.neg++;
      break;
    }
  }
  // a line drawn straight through a small inline symbol (instrument on the pipe) reaches it too
  for (const net of nets) {
    if (net.dash) continue;
    for (const x of boxes) {
      if (x.cat === "equipment" || net.touches.some((t) => t.item === x.id)) continue;
      const shrink: BBox = [x.b[0] + 0.2 * (x.b[2] - x.b[0]), x.b[1] + 0.2 * (x.b[3] - x.b[1]), x.b[2] - 0.2 * (x.b[2] - x.b[0]), x.b[3] - 0.2 * (x.b[3] - x.b[1])];
      const hit = net.path.find(([a, b]) => segHitsBox(a, b, shrink));
      if (hit) net.touches.push({ item: x.id, at: [Math.round((shrink[0] + shrink[2]) / 2), Math.round((shrink[1] + shrink[3]) / 2)] });
    }
  }
  return nets.filter((x) => x.touches.length || x.attaches.length || x.len >= 4 * L0);
}

function segsCross(p1: Pt, p2: Pt, q1: Pt, q2: Pt) {
  const o = (a: Pt, b: Pt, c: Pt) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p1, p2, q1) !== o(p1, p2, q2) && o(q1, q2, p1) !== o(q1, q2, p2);
}

function segHitsBox(a: Pt, b: Pt, r: BBox) {
  // Liang–Barsky clip
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0] - r[0], r[2] - a[0], a[1] - r[1], r[3] - a[1]];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return false;
    } else {
      const t = q[k] / p[k];
      if (p[k] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Item adjacency through solid nets: item → items it is piped to, with the net between them. */
export function pipedNeighbours(nets: Net[]) {
  const adj = new Map<string, Map<string, string>>();
  for (const n of nets) {
    if (n.dash) continue;
    for (const a of n.touches)
      for (const b of n.touches) {
        if (a.item === b.item) continue;
        if (!adj.has(a.item)) adj.set(a.item, new Map());
        adj.get(a.item)!.set(b.item, n.id);
      }
  }
  return adj;
}

/**
 * The drawn route between two points of one net: shortest path over its pieces, with tees split
 * and bridged breaks joined again. Returns page-px points, straight runs merged; null if none.
 */
export function netPath(net: Net, from: Pt, to: Pt): Pt[] | null {
  const segs = net.path;
  if (!segs.length) return null;
  const tol = 3 + net.w;
  const nodes: Pt[] = [];
  const nodeAt = (p: Pt) => {
    for (let k = 0; k < nodes.length; k++) if (Math.hypot(nodes[k][0] - p[0], nodes[k][1] - p[1]) <= tol) return k;
    nodes.push([p[0], p[1]]);
    return nodes.length - 1;
  };
  const ends = segs.map(([a, b]) => [nodeAt(a), nodeAt(b)]);
  // tees: an end lying on another piece splits that piece there
  const splits: number[][] = segs.map(() => []);
  nodes.forEach((p, k) => {
    segs.forEach(([a, b], j) => {
      if (ends[j][0] === k || ends[j][1] === k) return;
      if (distPtSeg(p, { a, b }) <= tol) splits[j].push(k);
    });
  });
  const adj = new Map<number, { to: number; d: number }[]>();
  const edge = (i: number, j: number) => {
    if (i === j) return;
    const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
    (adj.get(i) ?? adj.set(i, []).get(i)!).push({ to: j, d });
    (adj.get(j) ?? adj.set(j, []).get(j)!).push({ to: i, d });
  };
  segs.forEach(([a], j) => {
    const along = [ends[j][0], ...splits[j], ends[j][1]].sort((x, y) => Math.hypot(nodes[x][0] - a[0], nodes[x][1] - a[1]) - Math.hypot(nodes[y][0] - a[0], nodes[y][1] - a[1]));
    for (let k = 1; k < along.length; k++) edge(along[k - 1], along[k]);
  });
  // bridged breaks: join the pieces again, nearest loose ends first, until one piece remains
  const comp = () => {
    const c = new Array(nodes.length).fill(-1);
    let n = 0;
    for (let s = 0; s < nodes.length; s++) {
      if (c[s] >= 0) continue;
      const st = [s];
      c[s] = n;
      while (st.length) for (const e of adj.get(st.pop()!) ?? []) if (c[e.to] < 0) (c[e.to] = n), st.push(e.to);
      n++;
    }
    return c;
  };
  let c = comp();
  if (new Set(c).size > 1) {
    const loose = nodes.map((_, k) => k).filter((k) => (adj.get(k)?.length ?? 0) <= 1);
    const pairs: [number, number, number][] = [];
    for (let x = 0; x < loose.length && loose.length < 400; x++)
      for (let y = x + 1; y < loose.length; y++) pairs.push([loose[x], loose[y], Math.hypot(nodes[loose[x]][0] - nodes[loose[y]][0], nodes[loose[x]][1] - nodes[loose[y]][1])]);
    pairs.sort((p, q) => p[2] - q[2]);
    for (const [x, y] of pairs) {
      if (c[x] === c[y]) continue;
      edge(x, y);
      c = comp();
      if (new Set(c).size === 1) break;
    }
  }
  const nearest = (p: Pt) => nodes.reduce((best, q, k) => (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(nodes[best][0] - p[0], nodes[best][1] - p[1]) ? k : best), 0);
  const s0 = nearest(from), t0 = nearest(to);
  if (s0 === t0) return null;
  // Dijkstra (small graphs)
  const dist = new Array(nodes.length).fill(Infinity), prev = new Array(nodes.length).fill(-1), done = new Array(nodes.length).fill(false);
  dist[s0] = 0;
  for (;;) {
    let u = -1;
    for (let k = 0; k < nodes.length; k++) if (!done[k] && dist[k] < Infinity && (u < 0 || dist[k] < dist[u])) u = k;
    if (u < 0 || u === t0) break;
    done[u] = true;
    for (const e of adj.get(u) ?? []) if (dist[u] + e.d < dist[e.to]) (dist[e.to] = dist[u] + e.d), (prev[e.to] = u);
  }
  if (dist[t0] === Infinity) return null;
  const pts: Pt[] = [];
  for (let k = t0; k >= 0; k = prev[k]) pts.unshift(nodes[k]);
  // merge straight runs
  const out: Pt[] = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1], b = pts[k], d = pts[k + 1];
    const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    if (Math.abs(cross) > 2 * Math.hypot(d[0] - a[0], d[1] - a[1])) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out.map((p) => [Math.round(p[0]), Math.round(p[1])] as Pt);
}
