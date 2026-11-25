import type { BBox } from "../types.ts";
import type { Net, Pt } from "./nets.ts";

/**
 * Page router over the drawn pipes (solid nets of the vector layer). The DEXPI drawing uses it to
 * draw a pipe the way the PDF draws it where no single net joins the two ends: through a tee onto
 * another line, across an arrowhead or a flow arrow that breaks the stroke, from a nozzle to a tee.
 * Pieces are joined end to end and where an end lies on another piece (a tee); a loose end continues
 * across a short break when the piece it ends lies in line with the gap and no symbol sits in it.
 * A route is only given when it is not a detour: a drawn path much longer than the distance means
 * the two ends are not joined on the drawing, and the guess stays (and shows as invented).
 */
/** A route end: a point (snapped to the nearest drawn piece) or a symbol box (the pipe ends at its edge). */
export type RouteEnd = { p: Pt } | { box: BBox };
export interface PageRouter {
  route(a: RouteEnd, b: RouteEnd): Pt[] | null;
  /** why the last route() gave null: no-start-a / no-start-b / shared / no-path / too-long */
  why: string;
  /** where a route from `from` first meets the polyline `onto` (a branch reaching its parent run) */
  meet(from: RouteEnd, onto: Pt[]): Pt | null;
  /** the drawn line from `from` toward `toward`, as far as it goes (no knee to close the gap) */
  stub(from: RouteEnd, toward: RouteEnd): Pt[] | null;
  /** the same over the thin and the dashed lines only (signal and data lines), never over a pipe */
  signal?: PageRouter;
}

class MinHeap {
  private h: [number, number][] = [];
  push(k: number, v: number) {
    const h = this.h;
    h.push([k, v]);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const h = this.h;
    if (!h.length) return undefined;
    const top = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.h.length;
  }
}

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function project(p: Pt, a: Pt, b: Pt): { q: Pt; t: number; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  const q: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { q, t, d: dist(p, q) };
}
function hitsBox(a: Pt, b: Pt, r: BBox) {
  for (let k = 0; k <= 8; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / 8, y = a[1] + ((b[1] - a[1]) * k) / 8;
    if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return true;
  }
  return false;
}

/**
 * `apparatus`: boxes of equipment (vessels, pumps, packages). A drawn line through or along such a box
 * is its outline or internals, never where a pipe leaves it; for every other symbol a line running
 * through it or right along its edge may start a route.
 */
export function buildRouter(nets: Net[], boxes: BBox[], W: number, apparatus: BBox[] = []): PageRouter {
  const solid = nets.filter((n) => !n.dash);
  const pieces: [Pt, Pt][] = solid.flatMap((n) => n.path as [Pt, Pt][]);
  const pieceNet: number[] = solid.flatMap((n, i) => n.path.map(() => i));
  const cell = Math.max(32, 0.01 * W);
  const tol = 3;
  const gapMax = 0.006 * W; // longest break bridged (arrowhead, flow arrow, a gap in the stroke)

  // nodes, snapped
  const nodes: Pt[] = [];
  const nodeGrid = new Map<string, number[]>();
  const gk = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const nodesNear = (p: Pt, r: number) => {
    const out: number[] = [];
    for (let i = Math.floor((p[0] - r) / cell); i <= Math.floor((p[0] + r) / cell); i++)
      for (let j = Math.floor((p[1] - r) / cell); j <= Math.floor((p[1] + r) / cell); j++) for (const k of nodeGrid.get(`${i},${j}`) ?? []) if (dist(nodes[k], p) <= r) out.push(k);
    return out;
  };
  const nodeAt = (p: Pt) => {
    const hit = nodesNear(p, tol)[0];
    if (hit !== undefined) return hit;
    nodes.push([p[0], p[1]]);
    const k = gk(p[0], p[1]);
    (nodeGrid.get(k) ?? nodeGrid.set(k, []).get(k)!).push(nodes.length - 1);
    return nodes.length - 1;
  };
  const ends = pieces.map(([a, b]) => [nodeAt(a), nodeAt(b)]);
  // pieces by cell, for tees and snapping
  const segGrid = new Map<string, number[]>();
  pieces.forEach(([a, b], j) => {
    for (let i = Math.floor((Math.min(a[0], b[0]) - tol) / cell); i <= Math.floor((Math.max(a[0], b[0]) + tol) / cell); i++)
      for (let k = Math.floor((Math.min(a[1], b[1]) - tol) / cell); k <= Math.floor((Math.max(a[1], b[1]) + tol) / cell); k++) {
        const key = `${i},${k}`;
        (segGrid.get(key) ?? segGrid.set(key, []).get(key)!).push(j);
      }
  });
  const segsNear = (p: Pt, r: number) => {
    const out = new Set<number>();
    for (let i = Math.floor((p[0] - r) / cell); i <= Math.floor((p[0] + r) / cell); i++)
      for (let j = Math.floor((p[1] - r) / cell); j <= Math.floor((p[1] + r) / cell); j++) for (const s of segGrid.get(`${i},${j}`) ?? []) out.add(s);
    return out;
  };
  // tees: an end lying on another piece splits it
  const splits: number[][] = pieces.map(() => []);
  nodes.forEach((p, k) => {
    for (const j of segsNear(p, tol)) {
      if (ends[j][0] === k || ends[j][1] === k) continue;
      if (project(p, pieces[j][0], pieces[j][1]).d <= tol) splits[j].push(k);
    }
  });
  const adj: { to: number; d: number }[][] = nodes.map(() => []);
  const edge = (i: number, j: number) => {
    if (i === j) return;
    const d = dist(nodes[i], nodes[j]);
    adj[i].push({ to: j, d });
    adj[j].push({ to: i, d });
  };
  pieces.forEach(([a], j) => {
    const along = [ends[j][0], ...splits[j], ends[j][1]].sort((x, y) => dist(nodes[x], a) - dist(nodes[y], a));
    for (let k = 1; k < along.length; k++) edge(along[k - 1], along[k]);
  });
  // breaks: a loose end continues in its own direction to the nearest node across a short gap
  const loose = nodes.map((_, k) => k).filter((k) => adj[k].length === 1);
  for (const k of loose) {
    const from = nodes[k], back = nodes[adj[k][0].to];
    const L = dist(from, back);
    if (L < 1e-6) continue;
    const u: Pt = [(from[0] - back[0]) / L, (from[1] - back[1]) / L];
    let best = -1, bd = Infinity;
    for (const m of nodesNear(from, gapMax)) {
      if (m === k || adj[k].some((e) => e.to === m)) continue;
      const v: Pt = [nodes[m][0] - from[0], nodes[m][1] - from[1]];
      const d = Math.hypot(v[0], v[1]);
      if (d < 1 || (v[0] * u[0] + v[1] * u[1]) / d < 0.97) continue;
      if (d < bd) [best, bd] = [m, d];
    }
    if (best >= 0 && !boxes.some((b) => hitsBox(from, nodes[best], b))) edge(k, best);
  }

  // one net is one drawn line (the net builder joined its pieces with its own tolerances): where the
  // pieces of a net fall apart here, join them again, nearest nodes first
  const byNet = new Map<number, Set<number>>();
  pieces.forEach((_, j) => {
    const set = byNet.get(pieceNet[j]) ?? byNet.set(pieceNet[j], new Set()).get(pieceNet[j])!;
    set.add(ends[j][0]);
    set.add(ends[j][1]);
    for (const k of splits[j]) set.add(k);
  });
  for (const set of byNet.values()) {
    const ns = [...set];
    if (ns.length < 2 || ns.length > 400) continue;
    const comp = new Map<number, number>();
    let c = 0;
    for (const s0 of ns) {
      if (comp.has(s0)) continue;
      const st = [s0];
      comp.set(s0, c);
      while (st.length) for (const e of adj[st.pop()!]) if (set.has(e.to) && !comp.has(e.to)) (comp.set(e.to, c), st.push(e.to));
      c++;
    }
    if (c < 2) continue;
    const pairs: [number, number, number][] = [];
    for (let x = 0; x < ns.length; x++) for (let y = x + 1; y < ns.length; y++) if (comp.get(ns[x]) !== comp.get(ns[y])) pairs.push([ns[x], ns[y], dist(nodes[ns[x]], nodes[ns[y]])]);
    pairs.sort((p, q) => p[2] - q[2]);
    const root = new Map<number, number>();
    const find = (k: number): number => (root.has(k) ? (root.set(k, find(root.get(k)!)), root.get(k)!) : k);
    for (const [x, y] of pairs) {
      const a = find(comp.get(x)!), b = find(comp.get(y)!);
      if (a === b) continue;
      edge(x, y);
      root.set(a, b);
    }
  }

  /** a temporary node on the nearest piece within `snap`, joined to that piece's neighbours */
  const snapTo = (p: Pt, snap: number): { q: Pt; links: { to: number; d: number }[] } | null => {
    let best: { q: Pt; j: number; d: number } | null = null;
    for (const j of segsNear(p, snap)) {
      const r = project(p, pieces[j][0], pieces[j][1]);
      if (r.d <= snap && (!best || r.d < best.d)) best = { q: r.q, j, d: r.d };
    }
    if (!best) return null;
    return onPiece(best.j, best.q);
  };
  /** a temporary node at q on piece j, joined to the nearest nodes either side along it */
  const onPiece = (j: number, q: Pt): { q: Pt; links: { to: number; d: number }[] } => {
    const best = { j, q };
    const [a] = pieces[best.j];
    const along = [ends[best.j][0], ...splits[best.j], ends[best.j][1]].sort((x, y) => dist(nodes[x], a) - dist(nodes[y], a));
    const tq = dist(best.q, a);
    let lo = along[0], hi = along[along.length - 1];
    for (const k of along) {
      if (dist(nodes[k], a) <= tq) lo = k;
      else {
        hi = k;
        break;
      }
    }
    return { q: best.q, links: [{ to: lo, d: dist(best.q, nodes[lo]) }, { to: hi, d: dist(best.q, nodes[hi]) }] };
  };

  /** Dijkstra from a snapped start; stops at `stop(node)` true. Returns node path (−1 = start). */
  const search = (s: { q: Pt; links: { to: number; d: number }[] }, stop: (k: number) => boolean, limit: number): number[] | null => {
    const d = new Map<number, number>(), prev = new Map<number, number>();
    const heap = new MinHeap();
    for (const l of s.links) if (l.d < (d.get(l.to) ?? Infinity)) (d.set(l.to, l.d), prev.set(l.to, -1), heap.push(l.d, l.to));
    while (heap.size) {
      const [du, u] = heap.pop()!;
      if (du > (d.get(u) ?? Infinity)) continue;
      if (du > limit) return null;
      if (stop(u)) {
        const path: number[] = [];
        for (let k = u; k !== -1; k = prev.get(k)!) path.unshift(k);
        return path;
      }
      for (const e of adj[u]) {
        const nd = du + e.d;
        if (nd < (d.get(e.to) ?? Infinity)) (d.set(e.to, nd), prev.set(e.to, u), heap.push(nd, e.to));
      }
    }
    return null;
  };
  const straighten = (pts: Pt[]): Pt[] => {
    const out: Pt[] = [pts[0]];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = out[out.length - 1], b = pts[k], c = pts[k + 1];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) > 1.5 * Math.max(dist(a, c), 1)) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out.filter((p, k) => k === 0 || dist(p, out[k - 1]) > 0.5);
  };
  const snapR = 0.004 * W;
  const margin = 0.004 * W;
  /** `from`: the point on a drawn line that runs through or along a symbol, where the route leaves it */
  type Link = { to: number; d: number; from?: Pt };
  type Start = { q: Pt; links: Link[] };
  const pass = Math.max(3, 0.0015 * W); // a line this close to a symbol's edge runs along it
  /** start links for a route end; for a box: the drawn ends at or inside its edge */
  const startOf = (e: RouteEnd): Start | null => {
    if ("p" in e) return snapTo(e.p, snapR) ?? snapTo(e.p, 3 * snapR);
    const b = e.box;
    const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const r = Math.hypot(b[2] - b[0], b[3] - b[1]) / 2 + margin;
    const inside = nodesNear(c, r).filter((k) => {
      const q = nodes[k];
      return q[0] >= b[0] - margin && q[0] <= b[2] + margin && q[1] >= b[1] - margin && q[1] <= b[3] + margin;
    });
    if (inside.length) {
      // a drawn line running through the symbol or right along its edge starts a route too: a pipe
      // with a symbol drawn on it (steam trap, in-line instrument) whose short stroke to the pipe is
      // symbol geometry, while another line ends inside the box
      const links = new Map<number, Link>(inside.map((k) => [k, { to: k, d: 0 }]));
      const inline = !apparatus.some((x) => x[0] === b[0] && x[1] === b[1] && x[2] === b[2] && x[3] === b[3]);
      if (inline) for (const j of segsNear(c, r)) {
        const q = project(c, pieces[j][0], pieces[j][1]).q;
        if (q[0] < b[0] - pass || q[0] > b[2] + pass || q[1] < b[1] - pass || q[1] > b[3] + pass) continue;
        if (inside.includes(ends[j][0]) || inside.includes(ends[j][1])) continue; // a line ending in the box already starts here
        for (const l of onPiece(j, q).links) if (!links.has(l.to) || l.d < links.get(l.to)!.d) links.set(l.to, { ...l, from: q });
      }
      return { q: c, links: [...links.values()] };
    }
    // no drawn end inside: a drawn line that runs through the symbol (in-line valve, bubble on the line)
    const links = new Map<number, number>();
    for (const j of segsNear(c, r)) {
      const pr = project(c, pieces[j][0], pieces[j][1]);
      const q = pr.q;
      if (q[0] < b[0] - margin || q[0] > b[2] + margin || q[1] < b[1] - margin || q[1] > b[3] + margin) continue;
      for (const l of onPiece(j, q).links) if (l.d < (links.get(l.to) ?? Infinity)) links.set(l.to, l.d);
    }
    return links.size ? { q: c, links: [...links].map(([to, d]) => ({ to, d })) } : null;
  };
  const centreOf = (e: RouteEnd): Pt => ("p" in e ? e.p : [(e.box[0] + e.box[2]) / 2, (e.box[1] + e.box[3]) / 2]);

  /** distance from a point to a route end (0 inside a box) */
  const gapTo = (p: Pt, e: RouteEnd) => ("p" in e ? dist(p, e.p) : Math.hypot(Math.max(e.box[0] - p[0], 0, p[0] - e.box[2]), Math.max(e.box[1] - p[1], 0, p[1] - e.box[3])));
  /**
   * No drawn line joins the two ends (an end placed beside the drawing, a break the router does not
   * bridge): follow the drawn line from `from` as far as it goes toward `to`, and leave only the short
   * rest as a knee. Only when the drawn part covers most of the way and does not wander.
   */
  const partial = (from: RouteEnd, s: Start, to: RouteEnd, limit: number, direct: number, reverse = false): Pt[] | null => {
    const d = new Map<number, number>(), prev = new Map<number, number>();
    const heap = new MinHeap();
    for (const l of s.links) if (l.d < (d.get(l.to) ?? Infinity)) (d.set(l.to, l.d), prev.set(l.to, -1), heap.push(l.d, l.to));
    let best = -1, bg = gapTo(centreOf(from), to);
    while (heap.size) {
      const [du, u] = heap.pop()!;
      if (du > (d.get(u) ?? Infinity) || du > limit) continue;
      const g = gapTo(nodes[u], to);
      if (g < bg - 1) [best, bg] = [u, g];
      for (const e of adj[u]) {
        const nd = du + e.d;
        if (nd < (d.get(e.to) ?? Infinity)) (d.set(e.to, nd), prev.set(e.to, u), heap.push(nd, e.to));
      }
    }
    if (best < 0 || bg > Math.min(0.25 * direct, 0.03 * W)) return null;
    const path: number[] = [];
    for (let k = best; k !== -1; k = prev.get(k)!) path.unshift(k);
    const pts: Pt[] = [...("p" in from ? [s.q] : []), ...path.map((k) => nodes[k])];
    // the rest: a knee from the last drawn point to the other end, continuing the drawn direction
    const last = pts[pts.length - 1], before = pts[pts.length - 2] ?? last, t = centreOf(to);
    const horiz = Math.abs(last[0] - before[0]) >= Math.abs(last[1] - before[1]);
    pts.push(horiz ? [t[0], last[1]] : [last[0], t[1]]);
    if ("p" in to) pts.push(t);
    r.why = "partial";
    const out = straighten(pts);
    return reverse ? out.reverse() : out;
  };

  const routeFrom = (a: RouteEnd, b: RouteEnd, sa: Start, sb: Start): Pt[] | null => {
    const [ca, cb] = [centreOf(a), centreOf(b)];
    const direct = Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]);
    const limit = 1.4 * direct + 4 * snapR;
    const targets = new Map(sb.links.map((l) => [l.to, l.d]));
    if ("p" in a && "p" in b && sa.links.every((l) => targets.has(l.to)) && sa.links.length === sb.links.length) return [sa.q, sb.q];
    // the two ends share a drawn end: nothing between them (a line passing a symbol is no such end)
    if (sa.links.some((l) => !l.from && sb.links.some((m) => m.to === l.to && !m.from))) return (r.why = "shared"), null;
    // both symbols on one drawn line that runs past them: straight along it
    for (const l of sa.links) {
      const m = l.from && sb.links.find((x) => x.from && x.to === l.to);
      if (m && dist(l.from!, m.from!) > 1 && Math.abs(Math.abs(dist(l.from!, nodes[l.to]) - dist(m.from!, nodes[l.to])) - dist(l.from!, m.from!)) < 1) return [l.from!, m.from!];
    }
    const path = search(sa, (k) => targets.has(k), limit);
    if (!path) {
      r.why = "no-path";
      return partial(a, sa, b, limit, direct) ?? partial(b, sb, a, limit, direct, true);
    }
    // a route leaving a symbol along a line that runs past it starts (ends) where that line passes it
    const fa = "p" in a ? sa.q : sa.links.find((l) => l.to === path[0] && l.from)?.from;
    const fb = "p" in b ? sb.q : sb.links.find((l) => l.to === path[path.length - 1] && l.from)?.from;
    const pts = [...(fa ? [fa] : []), ...path.map((k) => nodes[k]), ...(fb ? [fb] : [])];
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += dist(pts[k - 1], pts[k]);
    if (!(pts.length >= 2 && L <= limit)) return (r.why = "too-long"), null;
    return straighten(pts);
  };

  const r: PageRouter = {
    why: "",
    route(a, b) {
      const sa = startOf(a), sb = startOf(b);
      r.why = !sa ? ("p" in a ? "no-start-a-pt" : "no-start-a-box") : !sb ? ("p" in b ? "no-start-b-pt" : "no-start-b-box") : "";
      if (!sa || !sb) return null;
      // lines running past a symbol are a fallback: a route over the symbol's own drawn ends goes first
      const own = (s: Start): Start => ({ q: s.q, links: s.links.filter((l) => !l.from) });
      if (![sa, sb].some((s) => s.links.some((l) => l.from))) return routeFrom(a, b, sa, sb);
      const base = routeFrom(a, b, own(sa), own(sb)), baseWhy = r.why;
      if (base && baseWhy !== "partial") return base;
      const wide = routeFrom(a, b, sa, sb);
      if (wide && r.why !== "partial") return wide;
      r.why = baseWhy;
      return base;
    },
    meet(from, onto) {
      if (onto.length < 2) return null;
      const s = startOf(from);
      if (!s) return null;
      const on = (p: Pt) => {
        for (let k = 0; k + 1 < onto.length; k++) if (project(p, onto[k], onto[k + 1]).d <= tol + 1) return true;
        return false;
      };
      if ("p" in from && on(s.q)) return s.q;
      const c = centreOf(from);
      const reach = Math.min(...onto.map((p) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]))) * 1.4 + 4 * snapR + 0.05 * W;
      const path = search(s, (k) => on(nodes[k]), reach);
      return path ? nodes[path[path.length - 1]] : null;
    },
    stub(from, toward) {
      const s0 = startOf(from);
      if (!s0) return null;
      const s: Start = { q: s0.q, links: s0.links.filter((l) => !l.from) };
      const direct = gapTo(centreOf(from), toward);
      const d = new Map<number, number>(), prev = new Map<number, number>();
      const heap = new MinHeap();
      for (const l of s.links) if (l.d < (d.get(l.to) ?? Infinity)) (d.set(l.to, l.d), prev.set(l.to, -1), heap.push(l.d, l.to));
      let best = -1, bg = direct;
      while (heap.size) {
        const [du, u] = heap.pop()!;
        if (du > (d.get(u) ?? Infinity) || du > 0.5 * direct) continue;
        const g = gapTo(nodes[u], toward);
        if (g < bg - 1) [best, bg] = [u, g];
        for (const e of adj[u]) {
          const nd = du + e.d;
          if (nd < (d.get(e.to) ?? Infinity)) (d.set(e.to, nd), prev.set(e.to, u), heap.push(nd, e.to));
        }
      }
      if (best < 0) return null;
      const path: number[] = [];
      for (let k = best; k !== -1; k = prev.get(k)!) path.unshift(k);
      const pts: Pt[] = [...("p" in from ? [s.q] : []), ...path.map((k) => nodes[k])];
      return pts.length >= 2 ? straighten(pts) : null;
    },
  };
  return r;
}
