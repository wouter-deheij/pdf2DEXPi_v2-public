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
 *    crossing the gap (filled arc).
 */
export function bridgeHops(segs: Seg[], W: number): Seg[] {
  return findHops(segs, W).map((h) => ({ a: h.P, b: h.Q, w: h.w, curve: false, dash: false, path: h.path, hop: true as const }));
}

export interface Hop {
  P: Pt;
  Q: Pt;
  w: number;
  path: number;
  style: "arc" | "mesh";
}

export function findHops(segs: Seg[], W: number): Hop[] {
  const out: Hop[] = [];
  const done: Pt[] = [];
  const add = (P: Pt, Q: Pt, w: number, path: number, style: Hop["style"]) => {
    const mid: Pt = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
    if (done.some((m) => dist(m, mid) < 0.5 * dist(P, Q))) return;
    done.push(mid);
    out.push({ P, Q, w, path, style });
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
  const long = segs.filter((s) => !s.curve && !s.dash && axisOf(s) && dist(s.a, s.b) >= 0.006 * W);
  const crossers = { h: long.filter((s) => axisOf(s) === "v"), v: long.filter((s) => axisOf(s) === "h") };
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
      // a line crosses the gap (that is what the pipe jumps over)
      const crossed = crossers[e.axis].some((s) =>
        h
          ? Math.abs(s.a[0] - mid[0]) < 0.35 * gap && Math.min(s.a[1], s.b[1]) < mid[1] - 0.5 * gap && Math.max(s.a[1], s.b[1]) > mid[1] + 0.5 * gap
          : Math.abs(s.a[1] - mid[1]) < 0.35 * gap && Math.min(s.a[0], s.b[0]) < mid[0] - 0.5 * gap && Math.max(s.a[0], s.b[0]) > mid[0] + 0.5 * gap,
      );
      if (!crossed) continue;
      const lo = h ? Math.min(e.p[0], f.p[0]) : Math.min(e.p[1], f.p[1]);
      const hi = h ? Math.max(e.p[0], f.p[0]) : Math.max(e.p[1], f.p[1]);
      const k = h ? mid[1] : mid[0];
      for (const sgn of [1, -1]) {
        const [a0, a1] = sgn > 0 ? [k, k + 0.8 * gap] : [k - 0.8 * gap, k];
        const ink = h ? tinyIn(lo, a0, hi, a1) : tinyIn(a0, lo, a1, hi);
        if (ink.length < 8) continue;
        // the arc is on one side only; a symbol drawn around the line (a dome, a bubble) is on both
        const [b0, b1] = sgn > 0 ? [k - 0.8 * gap, k] : [k, k + 0.8 * gap];
        if ((h ? tinyIn(lo, b0, hi, b1) : tinyIn(b0, lo, b1, hi)).length > 0.3 * ink.length) continue;
        // the arc spans the gap along the line and bulges off it in the middle
        const bins = new Set(ink.map((m) => Math.min(9, Math.floor((10 * ((h ? m[0] : m[1]) - lo)) / (hi - lo)))));
        if (bins.size < 8) continue;
        const bulge = Math.max(...ink.filter((m) => Math.abs((h ? m[0] : m[1]) - (lo + hi) / 2) < 0.2 * gap).map((m) => Math.abs((h ? m[1] : m[0]) - k)), 0);
        if (bulge < 0.25 * gap) continue;
        // the arc starts at both pipe ends
        const r0 = Math.max(4, 0.15 * gap);
        if (![e.p, f.p].every((X) => ink.some((m) => dist(m, X) <= r0))) continue;
        // the jumped line runs on well past the arc on the arc's side (a symbol outline does not)
        const past = crossers[e.axis].some((s) => {
          const [c, a, z] = h ? [s.a[0], Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])] : [s.a[1], Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
          const reach = k + sgn * (bulge + 0.5 * gap);
          return Math.abs(c - (h ? mid[0] : mid[1])) < 0.35 * gap && a < Math.min(k, reach) && z > Math.max(k, reach);
        });
        if (!past) continue;
        add(e.p, f.p, e.w, e.path, "mesh");
        break;
      }
    }
  }
  return out;
}
