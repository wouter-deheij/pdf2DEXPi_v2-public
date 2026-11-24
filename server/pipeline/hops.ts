import type { Seg } from "./vector.ts";

type Pt = [number, number];
const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const axisOf = (s: Seg): "h" | "v" | null => (Math.abs(s.a[1] - s.b[1]) <= 1 ? "h" : Math.abs(s.a[0] - s.b[0]) <= 1 ? "v" : null);

interface End {
  p: Pt;
  dir: Pt; // unit, pointing out of the piece
  axis: "h" | "v";
  w: number;
  path: number;
}

/**
 * Line hops: where a pipe jumps over another line with a half circle, the PDF breaks the pipe and
 * draws the arc. The arc is not a pipe piece (a curve, or a mesh of tiny filled triangles), so the
 * pipe falls apart into pieces and the piece between two hops is lost as a stray stroke. This finds
 * the hops and returns one straight piece across each gap, so the pipe is one drawn line again.
 *
 * Two drawing styles are recognised, both only between two straight pipe ends on one line that face
 * each other across the arc:
 *  - one path: a short stub, Bézier arc piece(s), a short stub (stroked arc);
 *  - a mesh of tiny pieces on one side of the gap, spanning it and bulging off the line, with a line
 *    crossing the gap (filled arc) — or a row of such hops over a few lines side by side;
 *  - one path of short straight pieces (an arc drawn as a polyline), stacked hops joined by tiny stubs.
 * Lines that cross the gap may run a px or two off the axis. The straight pieces of a polyline or mesh
 * arc are taken out: left in, the top of the arc lies on the line it jumps and reads as a tee there.
 */
export function bridgeHops(segs: Seg[], W: number): { bridges: Seg[]; drop: Set<number> } {
  const hops = findHops(segs, W);
  // an arc drawn as straight pieces would read as pipe, its top touching the line it jumps (a false
  // tee): its path goes (polyline), or every path of tiny pieces wholly inside the arc (mesh)
  const drop = new Set(hops.filter((h) => h.style === "poly").map((h) => h.path));
  const regions = hops.filter((h) => h.region).map((h) => h.region!);
  if (regions.length) {
    const tinyMax = 0.0015 * W;
    const byPath = new Map<number, Seg[]>();
    for (const s of segs) (byPath.get(s.path) ?? byPath.set(s.path, []).get(s.path)!).push(s);
    const inR = (p: Pt, r: [number, number, number, number]) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
    for (const [pid, ps] of byPath)
      if (ps.every((s) => !s.dash && dist(s.a, s.b) < tinyMax) && regions.some((r) => ps.every((s) => inR(s.a, r) && inR(s.b, r)))) drop.add(pid);
  }
  return {
    bridges: hops.map((h) => ({ a: h.P, b: h.Q, w: h.w, curve: false, dash: false, path: h.path, hop: true as const })),
    drop,
  };
}

export interface Hop {
  P: Pt;
  Q: Pt;
  w: number;
  path: number;
  style: "arc" | "mesh" | "poly";
  /** mesh: the box the arc's pieces lie in */
  region?: [number, number, number, number];
}

export function findHops(segs: Seg[], W: number): Hop[] {
  const out: Hop[] = [];
  const done: Pt[] = [];
  const add = (P: Pt, Q: Pt, w: number, path: number, style: Hop["style"], region?: Hop["region"]) => {
    const mid: Pt = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
    if (done.some((m) => dist(m, mid) < 0.5 * dist(P, Q))) return;
    done.push(mid);
    out.push({ P, Q, w, path, style, region });
  };

  // straight pipe ends on an axis
  const ends: End[] = [];
  for (const s of segs) {
    if (s.curve || s.dash) continue;
    const L = dist(s.a, s.b);
    const axis = axisOf(s);
    if (L < 8 || !axis) continue;
    ends.push({ p: s.a, dir: [(s.a[0] - s.b[0]) / L, (s.a[1] - s.b[1]) / L], axis, w: s.w, path: s.path });
    ends.push({ p: s.b, dir: [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L], axis, w: s.w, path: s.path });
  }
  const cell = Math.max(32, 0.01 * W);
  const endGrid = new Map<string, End[]>();
  const gk = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const e of ends) (endGrid.get(gk(e.p[0], e.p[1])) ?? endGrid.set(gk(e.p[0], e.p[1]), []).get(gk(e.p[0], e.p[1]))!).push(e);
  const endsNear = (p: Pt, r: number) => {
    const res: End[] = [];
    for (let i = Math.floor((p[0] - r) / cell); i <= Math.floor((p[0] + r) / cell); i++)
      for (let j = Math.floor((p[1] - r) / cell); j <= Math.floor((p[1] + r) / cell); j++) for (const e of endGrid.get(`${i},${j}`) ?? []) if (dist(e.p, p) <= r) res.push(e);
    return res;
  };

  // 1. stroked arc: stub – arc – stub in one path
  const byPath = new Map<number, Seg[]>();
  for (const s of segs) (byPath.get(s.path) ?? byPath.set(s.path, []).get(s.path)!).push(s);
  for (const [pid, ps] of byPath) {
    if (ps.length > 12 || !ps.some((s) => s.curve) || ps.some((s) => s.dash)) continue;
    if (ps.slice(1).some((s, k) => dist(ps[k].b, s.a) > 0.6)) continue; // one chain
    const P = ps[0].a, Q = ps[ps.length - 1].b, span = dist(P, Q);
    if (span < 0.002 * W || span > 0.012 * W) continue;
    const axis = Math.abs(P[1] - Q[1]) <= 1.5 ? "h" : Math.abs(P[0] - Q[0]) <= 1.5 ? "v" : null;
    if (!axis) continue;
    if (ps.some((s) => !s.curve && dist(s.a, s.b) > 0.35 * span)) continue; // only short stubs
    const u: Pt = [(Q[0] - P[0]) / span, (Q[1] - P[1]) / span];
    const off = ps.flatMap((s) => [s.a, s.b]).map((x) => (x[0] - P[0]) * u[1] - (x[1] - P[1]) * u[0]);
    if (Math.max(...off) > 0.5 && Math.min(...off) < -0.5) continue; // one side only
    if (Math.max(...off.map(Math.abs)) > 0.8 * span) continue;
    const meets = (X: Pt, toward: Pt) => endsNear(X, 2.5).some((e) => e.path !== pid && e.axis === axis && e.dir[0] * toward[0] + e.dir[1] * toward[1] > 0.95);
    if (!meets(P, u) || !meets(Q, [-u[0], -u[1]])) continue;
    add(P, Q, ps[0].w, pid, "arc");
  }

  // 1b. arc drawn as a polyline: one path of short straight pieces, stacked hops joined by tiny stubs
  const allEnds = segs.filter((s) => !s.curve && !s.dash).flatMap((s) => [{ p: s.a, s }, { p: s.b, s }]);
  const eGrid = new Map<string, { p: Pt; s: Seg }[]>();
  for (const e of allEnds) (eGrid.get(gk(e.p[0], e.p[1])) ?? eGrid.set(gk(e.p[0], e.p[1]), []).get(gk(e.p[0], e.p[1]))!).push(e);
  const anyEndNear = (X: Pt, pid: number) => {
    for (let i = Math.floor((X[0] - 3) / cell); i <= Math.floor((X[0] + 3) / cell); i++)
      for (let j = Math.floor((X[1] - 3) / cell); j <= Math.floor((X[1] + 3) / cell); j++) for (const e of eGrid.get(`${i},${j}`) ?? []) if (e.s.path !== pid && dist(e.p, X) <= 2.5) return true;
    return false;
  };
  // long lines, nearly on an axis (a line drawn across the sheet may drift a px or two)
  const longLines = segs.filter((s) => !s.curve && !s.dash && dist(s.a, s.b) >= 0.006 * W && Math.min(Math.abs(s.a[0] - s.b[0]), Math.abs(s.a[1] - s.b[1])) <= 0.01 * dist(s.a, s.b));
  /** does line s cross the gap at `mid` (pipe on `axis`), reaching past the arc on both sides */
  const across = (s: Seg, axis: "h" | "v", mid: Pt, span: number, reach: number) => {
    const [k, o] = axis === "h" ? [0, 1] : [1, 0]; // s runs along o, across the pipe's axis k
    const lo = Math.min(s.a[o], s.b[o]), hi = Math.max(s.a[o], s.b[o]);
    if (Math.abs(s.b[o] - s.a[o]) < Math.abs(s.b[k] - s.a[k])) return false;
    if (lo > mid[o] - reach || hi < mid[o] + reach) return false;
    const t = (mid[o] - s.a[o]) / (s.b[o] - s.a[o]);
    return Math.abs(s.a[k] + t * (s.b[k] - s.a[k]) - mid[k]) < 0.35 * span;
  };
  /** stroke width of the pipe on the line through P and Q: the nearest straight piece on it, beyond either end */
  const pipeWidthAt = (P: Pt, Q: Pt, axis: "h" | "v"): number | null => {
    const [k, o] = axis === "h" ? [0, 1] : [1, 0];
    let best: number | null = null, bd = 0.03 * W;
    for (const s of segs) {
      if (s.curve || s.dash || axisOf(s) !== axis || dist(s.a, s.b) < 8 || Math.abs(s.a[o] - P[o]) > 1.5) continue;
      for (const X of [P, Q]) for (const e of [s.a, s.b]) {
        const d = Math.abs(e[k] - X[k]);
        if (d < bd && (e[k] - X[k]) * (X === P ? P[k] - Q[k] : Q[k] - P[k]) >= -1) [best, bd] = [s.w, d];
      }
    }
    return best;
  };
  for (const [pid, ps] of byPath) {
    if (ps.length < 4 || ps.length > 48 || ps.some((s) => s.curve || s.dash)) continue;
    if (ps.slice(1).some((s, k) => dist(ps[k].b, s.a) > 0.6)) continue; // one chain
    const P = ps[0].a, Q = ps[ps.length - 1].b, span = dist(P, Q);
    if (span < 0.002 * W || span > 0.012 * W) continue;
    const axis = Math.abs(P[1] - Q[1]) <= 1.5 ? "h" : Math.abs(P[0] - Q[0]) <= 1.5 ? "v" : null;
    if (!axis) continue;
    if (ps.some((s) => dist(s.a, s.b) > 0.4 * span)) continue; // short pieces only
    const u: Pt = [(Q[0] - P[0]) / span, (Q[1] - P[1]) / span];
    const off = ps.flatMap((s) => [s.a, s.b]).map((x) => (x[0] - P[0]) * u[1] - (x[1] - P[1]) * u[0]);
    if (Math.max(...off) > 0.5 && Math.min(...off) < -0.5) continue; // one side only
    const bulge = Math.max(...off.map(Math.abs));
    // lines through the gap, across the pipe's axis: one, or a few side by side (a row of hops in one path)
    const mid: Pt = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
    const [k, o] = axis === "h" ? [0, 1] : [1, 0];
    const [lo, hi] = [Math.min(P[k], Q[k]), Math.max(P[k], Q[k])];
    const at = longLines
      .filter((s) => Math.abs(s.b[o] - s.a[o]) >= Math.abs(s.b[k] - s.a[k]) && Math.min(s.a[o], s.b[o]) < mid[o] - bulge && Math.max(s.a[o], s.b[o]) > mid[o] + bulge)
      .map((s) => s.a[k] + ((mid[o] - s.a[o]) / (s.b[o] - s.a[o])) * (s.b[k] - s.a[k]))
      .filter((c) => c > lo + 0.05 * span && c < hi - 0.05 * span);
    const n = new Set(at.map((c) => Math.round(c / 3))).size;
    if (!n || n > 4) continue;
    if (n === 1 && !longLines.some((s) => across(s, axis, mid, span, bulge))) continue;
    if (bulge < (0.25 * span) / n || bulge > 0.8 * span) continue;
    // both ends go on: the pipe, or the next hop's stub
    if (!anyEndNear(P, pid) || !anyEndNear(Q, pid)) continue;
    // the bridge is the pipe, not the arc: an arc is often stroked thinner than its pipe
    add(P, Q, pipeWidthAt(P, Q, axis) ?? ps[0].w, pid, "poly");
  }

  // 2. filled arc: a mesh of tiny pieces beside the gap
  const tinyMax = 0.0015 * W;
  const tiny = segs.filter((s) => !s.dash && dist(s.a, s.b) < tinyMax);
  const tGrid = new Map<string, Pt[]>();
  for (const s of tiny) {
    const m: Pt = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    (tGrid.get(gk(m[0], m[1])) ?? tGrid.set(gk(m[0], m[1]), []).get(gk(m[0], m[1]))!).push(m);
  }
  const tinyIn = (x0: number, y0: number, x1: number, y1: number) => {
    const res: Pt[] = [];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) for (const m of tGrid.get(`${i},${j}`) ?? []) if (m[0] >= x0 && m[0] <= x1 && m[1] >= y0 && m[1] <= y1) res.push(m);
    return res;
  };
  // crossing lines, nearly on an axis (see longLines)
  const along = (s: Seg) => (Math.abs(s.b[0] - s.a[0]) >= Math.abs(s.b[1] - s.a[1]) ? "h" : "v");
  const crossers = { h: longLines.filter((s) => along(s) === "v"), v: longLines.filter((s) => along(s) === "h") };
  const gapMin = 0.003 * W, gapMax = 0.016 * W;
  for (const e of ends) {
    for (const f of endsNear(e.p, gapMax)) {
      if (f === e || f.axis !== e.axis || f.path === e.path || Math.abs(e.w - f.w) > 0.6) continue;
      const gap = dist(e.p, f.p);
      if (gap < gapMin || gap > gapMax) continue;
      if (e.dir[0] * f.dir[0] + e.dir[1] * f.dir[1] > -0.98) continue; // facing
      if ((f.p[0] - e.p[0]) * e.dir[0] + (f.p[1] - e.p[1]) * e.dir[1] < 0.98 * gap) continue; // straight ahead
      if (Math.abs(e.axis === "h" ? f.p[1] - e.p[1] : f.p[0] - e.p[0]) > 1.5) continue; // on one line, not just nearly
      const h = e.axis === "h";
      const mid: Pt = [(e.p[0] + f.p[0]) / 2, (e.p[1] + f.p[1]) / 2];
      const lo = h ? Math.min(e.p[0], f.p[0]) : Math.min(e.p[1], f.p[1]);
      const hi = h ? Math.max(e.p[0], f.p[0]) : Math.max(e.p[1], f.p[1]);
      const k = h ? mid[1] : mid[0];
      // lines crossing the gap (what the pipe jumps over): one, or a few side by side (one hop each)
      const at = (s: Seg) => {
        // where s crosses the pipe's line (s runs across it, perhaps a px or two off the axis)
        const [i, j] = h ? [1, 0] : [0, 1]; // s runs along i; the pipe's line is j = k... in s's terms
        const t = (k - s.a[i]) / (s.b[i] - s.a[i] || 1e-9);
        return { c: s.a[j] + t * (s.b[j] - s.a[j]), lo: Math.min(s.a[i], s.b[i]), hi: Math.max(s.a[i], s.b[i]) };
      };
      const cross = crossers[e.axis].map((s) => ({ s, ...at(s) })).filter((x) => x.c > lo + 0.05 * gap && x.c < hi - 0.05 * gap && x.lo < k - 0.5 * gap / 3 && x.hi > k + 0.5 * gap / 3);
      const cs = [...new Set(cross.map((x) => Math.round(x.c / 3)))];
      if (!cs.length || cs.length > 4) continue;
      const n = cs.length;
      if (n === 1 && !cross.some((x) => Math.abs(x.c - (h ? mid[0] : mid[1])) < 0.35 * gap && x.lo < k - 0.5 * gap && x.hi > k + 0.5 * gap)) continue;
      for (const sgn of [1, -1]) {
        const [a0, a1] = sgn > 0 ? [k, k + 0.8 * gap] : [k - 0.8 * gap, k];
        const ink = h ? tinyIn(lo, a0, hi, a1) : tinyIn(a0, lo, a1, hi);
        if (ink.length < 8) continue;
        // the arc is on one side only; a symbol drawn around the line (a dome, a bubble) is on both
        const [b0, b1] = sgn > 0 ? [k - 0.8 * gap, k] : [k, k + 0.8 * gap];
        if ((h ? tinyIn(lo, b0, hi, b1) : tinyIn(b0, lo, b1, hi)).length > 0.3 * ink.length) continue;
        // the arc spans the gap along the line and bulges off it in the middle (each hop of a row: over its line)
        const bins = new Set(ink.map((m) => Math.min(9, Math.floor((10 * ((h ? m[0] : m[1]) - lo)) / (hi - lo)))));
        if (bins.size < 8) continue;
        const off = (m: Pt) => Math.abs((h ? m[1] : m[0]) - k);
        const bulge = n === 1 ? Math.max(...ink.filter((m) => Math.abs((h ? m[0] : m[1]) - (lo + hi) / 2) < 0.2 * gap).map(off), 0) : Math.min(...cs.map((c) => Math.max(...ink.filter((m) => Math.abs((h ? m[0] : m[1]) - 3 * c) < 0.1 * gap).map(off), 0)));
        if (bulge < (0.25 * gap) / n) continue;
        // the arc starts at both pipe ends
        const r0 = Math.max(4, 0.15 * gap / n);
        if (![e.p, f.p].every((X) => ink.some((m) => dist(m, X) <= r0))) continue;
        // the jumped line runs on well past the arc on the arc's side (a symbol outline does not)
        const reach = k + sgn * (bulge + (0.5 * gap) / n);
        if (!cross.some((x) => x.lo < Math.min(k, reach) && x.hi > Math.max(k, reach))) continue;
        const [c0, c1] = sgn > 0 ? [k - 1.5, k + bulge + 2] : [k - bulge - 2, k + 1.5];
        add(e.p, f.p, e.w, e.path, "mesh", h ? [lo - 1.5, c0, hi + 1.5, c1] : [c0, lo - 1.5, c1, hi + 1.5]);
        break;
      }
    }
  }
  return out;
}
