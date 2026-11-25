import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { BBox, DrawingModel, Item } from "../types.ts";
import { esc } from "./xml.ts";
import type { PageRouter, RouteEnd } from "./router.ts";
import { bool, color, comps, data, dbl, enumRef, nn, obj, point, ref, str, stroke, type Node } from "./xmlnode.ts";

/**
 * DEXPI 2.0.1 drawing layer (Core/Diagram) placed on the positions read from the PDF.
 *
 * - equipment: library symbol stretched into the item's box, tag label above it;
 *   nozzles on the box edge facing the neighbouring element of the run;
 * - valves/components: symbol on the box centre, turned along the run;
 * - off-page connectors: in/out arrow at the box, turned along the flow;
 * - tees: a node where the branch meets the parent run;
 * - pipes: ConnectorLines between the piping nodes, orthogonal with at most one bend;
 * - instruments: ISA bubble on the box, measuring line to the sensing point, dashed signal line
 *   to the actuator of the valve they drive.
 * Coordinates: millimetres, y down, origin top-left (DEXPI 2.x). Pages are stacked vertically.
 * Symbols: reference/dexpi_symbols_2.0.1.json (DEXPI 2.0.1 reference P&ID shapes, CC BY 4.0,
 * plus FlowBite_DEXPI_v1 shapes) and two own fallbacks (generic valve, generic in-line item).
 *
 * The same drawing is also written as SVG for the web UI.
 */

// ---------- trace handed over by the DEXPI model builder ----------
export type TraceElem =
  | { kind: "nozzle"; id: string; node: string; eq: string }
  | { kind: "opc"; id: string; node: string; inlet: boolean }
  | { kind: "comp"; id: string; cls: string; n1: string; n2: string; hasNumber: boolean }
  | { kind: "tee"; id: string; nodes: [string, string, string]; at?: { page: number; p: [number, number] } }
  | { kind: "teeEnd"; id: string; node: string };
export interface TraceLine {
  id: string;
  sys: string;
  label: string;
  service: string | null;
  elems: TraceElem[];
  segments: { id: string; members: string[]; pipes: { id: string; src: string; tgt: string }[] }[];
}
export interface TraceInstrument {
  id: string;
  sensing: { kind: "nozzle" | "segment"; id: string } | null;
  ml: string;
  mlVia?: string; // drawn signal line (model.signal_lines) carrying it
  tap?: { page: number; at: [number, number] }; // where its drawn line meets the pipe (vector layer)
  acts: { as: string; ca: string; sl: string; valve: string; number: string; via?: string }[];
  sigs: { id: string; target: string; via?: string; inferred?: boolean }[]; // instrument → instrument SignalLineFunctions (inferred: from the loop number, not drawn)
  category: boolean;
  functions: boolean;
  number: boolean;
}
export interface DexpiTrace {
  equipment: { id: string; cls: string }[];
  lines: TraceLine[];
  nozzles: { id: string; node: string; eq: string; instrument: boolean }[];
  instruments: TraceInstrument[];
}

// ---------- symbol library ----------
interface Lib {
  license: string;
  class_symbol: Record<string, string>;
  studio: { class_symbol: Record<string, string>; aliases: Record<string, string>; dexpi_class: Record<string, string> };
  dexpi_class_symbols: Record<string, { symbol: string; quality: string }[]>;
  symbols: Record<string, { bbox: [number, number, number, number]; source: string; xml: string }>;
}
let LIB: Lib | null = null;
function lib(): Lib {
  if (LIB) return LIB;
  LIB = JSON.parse(fs.readFileSync(path.join(ROOT, "reference", "dexpi_symbols_2.0.1.json"), "utf8")) as Lib;
  const black = "<AggregatedDataValue type=\"Core/Diagram.Stroke\"><Data property=\"Color\">" + color([0, 0, 0]) + "</Data><Data property=\"DashStyle\"><DataReference data=\"Core/Diagram.DashStyle.Solid\"/></Data><Data property=\"Width\"><Double>0.25</Double></Data></AggregatedDataValue>";
  const poly = (pts: [number, number][]) => `<Object type="Core/Diagram.PolyLine"><Data property="Points">${pts.map(([x, y]) => point(x, y)).join("")}</Data><Data property="Stroke">${black}</Data></Object>`;
  const own = (name: string, prims: string[], bbox: [number, number, number, number]) => {
    LIB!.symbols[name] = {
      bbox,
      source: "pid-to-dexpi (own)",
      xml: `<Object type="Core/Diagram.Shape"><Data property="Name"><String>${name}</String></Data><Components property="Primitives">${prims.join("")}</Components><Data property="SymbolRegistrationNumber"><String>PID-TO-DEXPI:${name}</String></Data></Object>`,
    };
  };
  // ISO 10628 generic valve (bow tie) and a generic in-line item (rectangle)
  own("PID_GENERIC_VALVE_SHAPE", [poly([[-5, -2.5], [5, 2.5], [5, -2.5], [-5, 2.5], [-5, -2.5]])], [-5, -2.5, 5, 2.5]);
  own("PID_GENERIC_INLINE_SHAPE", [poly([[-4, -2], [4, -2], [4, 2], [-4, 2], [-4, -2]])], [-4, -2, 4, 2]);
  return LIB;
}

function chooseSymbol(cls: string, fallback: "equipment" | "valve" | "inline"): string {
  const L = lib();
  if (L.class_symbol[cls]) return L.class_symbol[cls];
  const sc0 = L.studio.dexpi_class[cls];
  const sc = sc0 ? (L.studio.aliases[sc0] ?? sc0) : null;
  if (sc && L.studio.class_symbol[sc]) return L.studio.class_symbol[sc];
  for (const [key, list] of Object.entries(L.dexpi_class_symbols)) {
    if (!key.endsWith(`.${cls}`)) continue;
    const best = list.find((x) => x.quality === "exact" || x.quality === "generiek");
    if (best && L.symbols[best.symbol]) return best.symbol;
  }
  return fallback === "equipment" ? L.class_symbol["*"] : fallback === "valve" ? "PID_GENERIC_VALVE_SHAPE" : "PID_GENERIC_INLINE_SHAPE";
}

// ---------- intermediate drawing (serialised to DEXPI XML and to SVG) ----------
type Pt = [number, number];
type RGB = [number, number, number];
interface Stroke { c: RGB; w: number; dash?: "Solid" | "Dash" }
type Frag = { attr: string; obj: string } | { lit: string };
type El =
  | { t: "use"; shape: string; p: Pt; rot: number; sx: number; sy: number }
  | { t: "text"; p: Pt; s: string; size: number; align: string; color: RGB; tpl?: Frag[] }
  | { t: "conn"; src: string; tgt: string; inner: Pt[]; stroke: Stroke }
  | { t: "poly"; pts: Pt[]; stroke: Stroke };
interface NP { id: string; kind: "piping" | "instr"; p: Pt; node?: string }
interface G { type: string; represents?: string; groups?: G[]; nodes?: NP[]; els?: El[] }

const C_LINE: RGB = [40, 40, 40], C_INSTR: RGB = [0, 128, 0], C_SIG: RGB = [0, 0, 200], C_TXT: RGB = [0, 0, 0];
const GAP = 0.05;
/** symbols where a pipe stops and picks up again at a label elsewhere on the page (a jump) */
const JUMP = new Set(["vent_drain_end", "valve_reference_arrow", "continuation_connector"]);
/** a knee over a tenth of the sheet with under 30 % of it on a drawn line is not drawn (vector pages) */
const KNEE_MAX = 0.1, KNEE_ON = 0.3;
/** length of a polyline */
const plen = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
/** a measuring line we make up ourselves over a fiftieth of the sheet with under 20 % of it on a drawn line is not drawn (vector pages) */
const ML_MAX = 0.02, ML_ON = 0.2;

const rg = (represents: string | undefined, groups: G[] = [], nodes: NP[] = []): G => ({ type: "Core/Diagram.RepresentationGroup", represents, groups, nodes });
const stat = (...els: El[]): G => ({ type: "Core/Diagram.Static", els });
const label = (kind: string, ...els: El[]): G => ({ type: `Plant/Diagram.${kind}`, els });
const text = (p: Pt, s: string, size: number, align = "CenterCenter", tpl?: Frag[], c: RGB = C_TXT): El => ({ t: "text", p, s, size, align, color: c, tpl });

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const mid = (r: BBox): Pt => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
function edgeToward(r: BBox, p: Pt | null): Pt {
  const [cx, cy] = mid(r);
  if (!p) return [cx, r[3]];
  const dx = p[0] - cx, dy = p[1] - cy;
  const hw = Math.max((r[2] - r[0]) / 2, 0.5), hh = Math.max((r[3] - r[1]) / 2, 0.5);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return [cx, r[3]];
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}
/** One bend: along the longer direction first. */
function knee(a: Pt, b: Pt): Pt[] {
  if (Math.abs(a[0] - b[0]) < GAP || Math.abs(a[1] - b[1]) < GAP) return [];
  return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [[b[0], a[1]]] : [[a[0], b[1]]];
}
/** where two polylines from (about) the same start part: the last point of `a`, walking from its start, still on `b` */
function parting(a: Pt[], b: Pt[], tol = 3): Pt | null {
  const off = (p: Pt) => {
    let best = Infinity;
    for (let k = 0; k + 1 < b.length; k++) {
      const [u, v] = [b[k], b[k + 1]];
      const dx = v[0] - u[0], dy = v[1] - u[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / L2));
      best = Math.min(best, Math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy));
    }
    return best;
  };
  let last: Pt | null = null;
  for (let k = 0; k + 1 < a.length; k++) {
    const [u, v] = [a[k], a[k + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(v[0] - u[0], v[1] - u[1]) / 2));
    for (let i = 0; i <= n; i++) {
      const p: Pt = [u[0] + ((v[0] - u[0]) * i) / n, u[1] + ((v[1] - u[1]) * i) / n];
      if (off(p) > tol) return last;
      last = p;
    }
  }
  return null; // a lies wholly on b: no parting
}
const inBox = (p: Pt, b: BBox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

function nearestOnPath(pts: Pt[], c: Pt): Pt {
  if (pts.length === 1) return pts[0];
  let best: Pt = pts[0], bd = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [A, B] = [pts[k], pts[k + 1]];
    const L2 = (B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2;
    const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((c[0] - A[0]) * (B[0] - A[0]) + (c[1] - A[1]) * (B[1] - A[1])) / L2));
    const p: Pt = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
    if (d < bd) [best, bd] = [p, d];
  }
  return best;
}

export function buildDiagram(model: DrawingModel, trace: DexpiTrace, routers?: Map<number, PageRouter>) {
  const L = lib();
  const notes: string[] = [];
  const MM = 25.4 / (model.dpi || 200);
  const pageOff = new Map<number, number>();
  let y = 0, W = 0;
  for (const p of [...model.pages].sort((a, b) => a.n - b.n)) {
    pageOff.set(p.n, y);
    y += p.px[1] * MM + 10;
    W = Math.max(W, p.px[0] * MM);
  }
  const H = Math.max(y - 10, 10);
  const items = new Map(model.items.map((i) => [i.id, i]));
  const rect = (it: Item | undefined): BBox | null => {
    if (!it) return null;
    const o = pageOff.get(it.page) ?? 0;
    return [it.bbox[0] * MM, it.bbox[1] * MM + o, it.bbox[2] * MM, it.bbox[3] * MM + o];
  };
  const toMM = (page: number, q: [number, number]): Pt => [q[0] * MM, q[1] * MM + (pageOff.get(page) ?? 0)];
  const pageOfMM = (q: Pt) => [...pageOff].filter(([, o]) => q[1] >= o - 1).sort((x, y) => y[1] - x[1])[0]?.[0];
  const toPx = (q: Pt): { page: number; p: Pt } | null => {
    const page = pageOfMM(q);
    return page === undefined ? null : { page, p: [q[0] / MM, (q[1] - pageOff.get(page)!) / MM] };
  };
  // exact routes from the PDF's vector geometry (vector layer), keyed by the two items they join
  const routes = new Map((model.pipe_routes ?? []).map((r) => [[r.a, r.b].sort().join("|"), r]));
  const nodeItem = new Map<string, string>();
  for (const l of trace.lines)
    for (const e of l.elems) {
      if (e.kind === "comp") { nodeItem.set(e.n1, e.id); nodeItem.set(e.n2, e.id); }
      else if (e.kind === "nozzle") nodeItem.set(e.node, e.eq);
      else if (e.kind === "opc") nodeItem.set(e.node, e.id);
    }
  const routeInner = (src: string, tgt: string): Pt[] | null => {
    const a = nodeItem.get(src), b = nodeItem.get(tgt);
    if (!a || !b || a === b) return null;
    const r = routes.get([a, b].sort().join("|"));
    if (!r) return null;
    const pts = (r.a === a ? r.pts : [...r.pts].reverse()).map((q) => toMM(r.page, q));
    return pts.length >= 2 ? pts : null;
  };
  // drawn signal lines: each is drawn once, by the first conveying function it carries
  const sigLines = new Map((model.signal_lines ?? []).map((l) => [l.id, l]));
  const sigDrawn = new Set<string>();
  const sigEls = (via: string | undefined): El[] | null => {
    const sl = via ? sigLines.get(via) : undefined;
    if (!sl) return null;
    if (sigDrawn.has(sl.id)) return [];
    sigDrawn.add(sl.id);
    const st: Stroke = { c: C_SIG, w: 0.18, dash: sl.type === "electrical" || sl.type === "software" ? "Dash" : "Solid" };
    return sl.path.filter((pl) => pl.length >= 2).map((pl) => ({ t: "poly" as const, pts: pl.map((q) => toMM(sl.page, q)), stroke: st }));
  };
  let routed = 0, pipesDrawn = 0, partlyRouted = 0, sigRouted = 0, jumps = 0, longKnees = 0, longMl = 0;
  const kneeWhy = new Map<string, number>();
  const usedShapes = new Set<string>();
  const use = (shape: string, p: Pt, rot = 0, sx = 1, sy = sx): El => (usedShapes.add(shape), { t: "use", shape, p, rot: ((rot % 360) + 360) % 360, sx, sy });
  const fit = (shape: string, r: BBox): El => {
    const [x0, y0, x1, y1] = L.symbols[shape].bbox;
    const sx = Math.max(Math.min((r[2] - r[0]) / Math.max(x1 - x0, 1e-3), 8), 0.05);
    const sy = Math.max(Math.min((r[3] - r[1]) / Math.max(y1 - y0, 1e-3), 8), 0.05);
    const c = mid(r);
    return use(shape, [c[0] - (sx * (x0 + x1)) / 2, c[1] - (sy * (y0 + y1)) / 2], 0, sx, sy);
  };

  /** a pipe along the drawn lines of the PDF where no single net joins its ends (page router, vector pages) */
  const routeEnd = (node: string, pos: Pt): { page: number; end: RouteEnd } | null => {
    const id = nodeItem.get(node);
    const it = id ? items.get(id) : undefined;
    if (it) return { page: it.page, end: { box: it.bbox } };
    const t = toPx(pos);
    return t ? { page: t.page, end: { p: t.p } } : null;
  };
  const drawnRoute = (src: string, tgt: string, a: Pt, b: Pt): Pt[] | null => {
    if (!routers?.size) return null;
    const ea = routeEnd(src, a), eb = routeEnd(tgt, b);
    if (!ea || !eb || ea.page !== eb.page) return null;
    const rt = routers.get(ea.page);
    const pts = rt?.route(ea.end, eb.end);
    if (!pts && rt) kneeWhy.set(rt.why, (kneeWhy.get(rt.why) ?? 0) + 1);
    if (pts && rt?.why === "partial") partlyRouted++;
    return pts && pts.length >= 1 ? pts.map((q) => toMM(ea.page, q)) : null;
  };

  // ---- 1. centres of the elements of every run
  const centre = new Map<TraceElem, Pt | null>();
  const elemCentre = (e: TraceElem): Pt | null => {
    if (e.kind === "nozzle") { const r = rect(items.get(e.eq)); return r ? mid(r) : null; }
    if (e.kind === "opc" || e.kind === "comp") { const r = rect(items.get(e.id)); return r ? mid(r) : null; }
    return null;
  };
  for (const l of trace.lines) for (const e of l.elems) centre.set(e, elemCentre(e));
  const known = (l: TraceLine, k: number, step: number) => {
    for (let j = k + step; j >= 0 && j < l.elems.length; j += step) {
      const c = centre.get(l.elems[j]);
      if (c) return c;
    }
    return null;
  };

  // ---- 2. tees: where the branch meets the parent run
  const teePos = new Map<string, Pt>();
  let teesDrawn = 0;
  const knownElem = (l: TraceLine, k: number, step: number): TraceElem | null => {
    for (let j = k + step; j >= 0 && j < l.elems.length; j += step) if (centre.get(l.elems[j])) return l.elems[j];
    return null;
  };
  const elemItem = (e: TraceElem): Item | undefined => (e.kind === "nozzle" ? items.get(e.eq) : e.kind === "opc" || e.kind === "comp" ? items.get(e.id) : undefined);
  for (const l of trace.lines)
    l.elems.forEach((e, k) => {
      if (e.kind !== "tee") return;
      // the junction is known from the drawn lines (a pipe added from the vector layer)
      if (e.at) {
        teePos.set(e.id, toMM(e.at.page, e.at.p));
        teesDrawn++;
        return;
      }
      const A = known(l, k, -1), B = known(l, k, 1);
      let C: Pt | null = null;
      for (const b of trace.lines) {
        const j = b.elems.findIndex((x) => x.kind === "teeEnd" && x.id === e.id);
        if (j >= 0) C = known(b, j, j === 0 ? 1 : -1);
      }
      // on the drawing: the drawn run between the two neighbours, and where the drawn branch meets it
      const ea = knownElem(l, k, -1), eb = knownElem(l, k, 1);
      let ec: TraceElem | null = null;
      for (const b of trace.lines) {
        const j = b.elems.findIndex((x) => x.kind === "teeEnd" && x.id === e.id);
        if (j >= 0) ec = knownElem(b, j, j === 0 ? 1 : -1);
      }
      const ia = ea && elemItem(ea), ib = eb && elemItem(eb), ic = ec && elemItem(ec);
      const R = ia && routers?.get(ia.page);
      if (R && ia && ib && ic && ib.page === ia.page && ic.page === ia.page) {
        const run = R.route({ box: ia.bbox }, { box: ib.bbox });
        const m = run && R.meet({ box: ic.bbox }, run);
        if (m) {
          teePos.set(e.id, toMM(ia.page, m));
          teesDrawn++;
          return;
        }
        // no drawn run between the neighbours: follow the branch to each of them; the tee is where the two routes part
        const toA = R.route({ box: ic.bbox }, { box: ia.bbox }), toB = R.route({ box: ic.bbox }, { box: ib.bbox });
        const fork = toA && toB && parting(toA, toB);
        if (fork && !inBox(fork, ic.bbox)) {
          teePos.set(e.id, toMM(ia.page, fork));
          teesDrawn++;
          return;
        }
      }
      const path = A && B ? [A, ...knee(A, B), B] : A ? [A] : B ? [B] : null;
      let p = path ? (C ? nearestOnPath(path, C) : path.length > 1 ? nearestOnPath(path, [(path[0][0] + path.at(-1)![0]) / 2, (path[0][1] + path.at(-1)![1]) / 2]) : path[0]) : C;
      // the tee ends a run (one neighbour on it): it lies on the drawn route from the branch to that neighbour
      const one = ia && !ib ? ia : ib && !ia ? ib : null;
      const R1 = one && routers?.get(one.page);
      if (p && one && ic && R1 && ic.page === one.page) {
        const rr = R1.route({ box: ic.bbox }, { box: one.bbox });
        const g = toPx(p);
        if (rr && rr.length >= 2 && g && g.page === one.page) {
          p = toMM(one.page, nearestOnPath(rr, g.p));
          teesDrawn++;
        }
      }
      if (p) teePos.set(e.id, p);
      else notes.push(`${e.id}: no position known for this tee; drawn at the origin.`);
    });
  for (const l of trace.lines) for (const e of l.elems) if ((e.kind === "tee" || e.kind === "teeEnd") && teePos.has(e.id)) centre.set(e, teePos.get(e.id)!);

  // ---- 3. piping node positions
  const nodePos = new Map<string, Pt>();
  const compDir = new Map<string, Pt>(); // unit vector along the run
  for (const l of trace.lines)
    l.elems.forEach((e, k) => {
      const c = centre.get(e) ?? [0, 0];
      if (e.kind === "nozzle") {
        const nb = k === 0 ? known(l, k, 1) : known(l, k, -1);
        nodePos.set(e.node, edgeToward(rect(items.get(e.eq))!, nb));
      } else if (e.kind === "opc" || e.kind === "teeEnd") {
        nodePos.set(e.node, c);
      } else if (e.kind === "tee") {
        for (const n of e.nodes) nodePos.set(n, c);
      } else {
        const prev = known(l, k, -1) ?? c, next = known(l, k, 1) ?? c;
        const dx = next[0] - prev[0], dy = next[1] - prev[1];
        let u: Pt = Math.abs(dx) >= Math.abs(dy) ? [1, 0] : [0, 1];
        if ((u[0] && dx < 0) || (u[1] && dy < 0)) u = [-u[0], -u[1]];
        const r = rect(items.get(e.id))!;
        const len = Math.max(2.5, Math.min(8, Math.max(r[2] - r[0], r[3] - r[1])));
        nodePos.set(e.n1, [c[0] - (u[0] * len) / 2, c[1] - (u[1] * len) / 2]);
        nodePos.set(e.n2, [c[0] + (u[0] * len) / 2, c[1] + (u[1] * len) / 2]);
        compDir.set(e.id, u);
      }
    });
  const placed = new Set<string>();
  const pnp = (node: string): G[] => {
    if (placed.has(node) || !nodePos.has(node)) return [];
    placed.add(node);
    return [rg(node, [], [{ id: `${node}.pos`, kind: "piping", p: nodePos.get(node)!, node }])];
  };

  // ---- 4. instruments: sensing points (needed by segments and nozzles)
  const segPath = new Map<string, Pt[][]>();
  for (const l of trace.lines)
    for (const s of l.segments)
      segPath.set(s.id, s.pipes.filter((p) => nodePos.has(p.src) && nodePos.has(p.tgt)).map((p) => { const a = nodePos.get(p.src)!, b = nodePos.get(p.tgt)!; return [a, ...knee(a, b), b]; }));
  // the legs at each jump arrow: the drawn one runs into it, the jump goes on from it to a label far off
  const jumpOf = (n: string) => { const id = nodeItem.get(n); return id && JUMP.has(items.get(id)?.type ?? "") ? id : null; };
  const legLen = (p: { src: string; tgt: string }) => { const a = nodePos.get(p.src), b = nodePos.get(p.tgt); return a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) : null; };
  const jumpLegs = new Map<string, number[]>();
  for (const l of trace.lines)
    for (const s of l.segments)
      for (const p of s.pipes) {
        const d = legLen(p);
        if (d == null) continue;
        for (const id of new Set([jumpOf(p.src), jumpOf(p.tgt)])) if (id) jumpLegs.set(id, [...(jumpLegs.get(id) ?? []), d]);
      }
  /** the jump itself: a long leg (a tenth of the sheet), clearly longer than the other leg at its arrow
   * (a lone leg may be drawn all the way) */
  const isJump = (p: { src: string; tgt: string }) => {
    const d = legLen(p);
    return d != null && d >= 0.1 * W && [p.src, p.tgt].some((n) => { const id = jumpOf(n); return !!id && (jumpLegs.get(id) ?? []).some((o) => o < 0.5 * d); });
  };
  const segSensing = new Map<string, NP[]>();
  const nozzleSensing = new Map<string, NP>();
  const sensePos = new Map<string, { id: string; p: Pt }>();
  for (const ins of trace.instruments) {
    const r = rect(items.get(ins.id));
    if (!r || !ins.sensing) continue;
    // the drawn tap point when the vector layer found one, else the bubble: nearest point on the pipe
    const c = ins.tap ? toMM(ins.tap.page, ins.tap.at) : mid(r);
    if (ins.sensing.kind === "segment") {
      const paths = segPath.get(ins.sensing.id) ?? [];
      if (!paths.length) continue;
      let best: Pt | null = null, bd = Infinity;
      for (const p of paths) { const q = nearestOnPath(p, c); const d = Math.hypot(q[0] - c[0], q[1] - c[1]); if (d < bd) [best, bd] = [q, d]; }
      const np: NP = { id: `${ins.id}.spos`, kind: "instr", p: best! };
      segSensing.set(ins.sensing.id, [...(segSensing.get(ins.sensing.id) ?? []), np]);
      sensePos.set(ins.id, { id: np.id, p: np.p });
    } else {
      const nz = trace.nozzles.find((n) => n.id === ins.sensing!.id);
      const er = nz ? rect(items.get(nz.eq)) : null;
      if (!nz || !er) continue;
      const p = nodePos.get(nz.node) ?? edgeToward(er, c);
      nodePos.set(nz.node, p);
      const np: NP = { id: `${nz.id}.ipos`, kind: "instr", p };
      nozzleSensing.set(nz.id, np);
      sensePos.set(ins.id, { id: np.id, p });
    }
  }

  // ---- 5. equipment
  const groups: G[] = [];
  for (const it of model.items.filter((i) => i.category === "equipment")) {
    const r = rect(it)!;
    const cls = trace.equipment.find((e) => e.id === it.id)?.cls ?? "*";
    const shape = chooseSymbol(cls, "equipment");
    const g: G[] = [
      stat(fit(shape, r)),
      // untagged equipment: show what it is (the TagName attribute holds an internal id)
      label("EquipmentTagNameLabel", it.tag ? text([mid(r)[0], r[1] - 0.8], it.tag, 2.0, "CenterBottom", [{ attr: "TagName", obj: it.id }]) : text([mid(r)[0], r[1] - 0.8], short(it.description ?? it.type, 22), 1.6, "CenterBottom")),
    ];
    for (const nz of trace.nozzles.filter((n) => n.eq === it.id)) {
      if (!nodePos.has(nz.node)) nodePos.set(nz.node, [mid(r)[0], r[3]]);
      const s = nozzleSensing.get(nz.id);
      g.push(rg(nz.id, pnp(nz.node), s ? [s] : []));
    }
    groups.push(rg(it.id, g));
  }

  // ---- 6. runs
  for (const l of trace.lines) {
    const byId = new Map(l.elems.map((e) => [e.kind === "teeEnd" ? `end:${e.id}` : e.id, e]));
    const segGroups: G[] = [];
    l.segments.forEach((s, si) => {
      const g: G[] = [];
      for (const m of s.members) {
        const e = byId.get(m);
        if (!e) continue;
        if (e.kind === "comp") {
          const it = items.get(e.id)!;
          const a = nodePos.get(e.n1)!, b = nodePos.get(e.n2)!;
          const c: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const u = compDir.get(e.id) ?? [1, 0];
          const shape = chooseSymbol(e.cls, it.category === "valve" ? "valve" : "inline");
          const [x0, , x1] = L.symbols[shape].bbox;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const sc = len / Math.max(x1 - x0, 1);
          const rot = (u[0] ? 0 : 90) + (u[0] < 0 || u[1] < 0 ? 180 : 0);
          const sub: G[] = [...pnp(e.n1), ...pnp(e.n2), stat(use(shape, c, rot, sc))];
          if (it.tag) {
            const lp: Pt = u[1] ? [c[0] + 2.4, c[1]] : [c[0], c[1] - 2.6];
            sub.push(label("ValveLabel", text(lp, it.tag, 1.3, u[1] ? "LeftCenter" : "CenterCenter", e.hasNumber ? [{ attr: "PipingComponentNumber", obj: e.id }] : undefined)));
          }
          g.push(rg(e.id, sub));
        } else if (e.kind === "tee") {
          g.push(rg(e.id, e.nodes.flatMap(pnp)));
        } else if (e.kind === "opc") {
          const it = items.get(e.id)!;
          const p = nodePos.get(e.node)!;
          const k = l.elems.indexOf(e);
          const nb = known(l, k, k === 0 ? 1 : -1) ?? [p[0] + 1, p[1]];
          const flow: Pt = e.inlet ? [nb[0] - p[0], nb[1] - p[1]] : [p[0] - nb[0], p[1] - nb[1]];
          const rot = Math.abs(flow[0]) + Math.abs(flow[1]) > GAP ? Math.round((Math.atan2(flow[1], flow[0]) * 180) / Math.PI / 90) * 90 : 0;
          const shape = e.inlet ? "ARROW_FOR_INLET_OF_ESSENTIAL_SUBSTANCES_SHAPE" : "ARROW_FOR_OUTLET_OF_ESSENTIAL_SUBSTANCES_SHAPE";
          let desc = [it.description, it.service].filter(Boolean).join(" — ");
          desc = short(desc, 24);
          const sub: G[] = [...pnp(e.node), stat(use(shape, p, rot, 0.45))];
          if (it.tag) sub.push(label("OffPageConnectorNumberLabel", text([p[0], p[1] - 3.2], it.tag, 1.6, "CenterCenter", [{ attr: "PipeConnectorNumber", obj: e.id }])));
          if (desc) sub.push(label("OffPageConnectorDescriptionLabel", text([p[0], p[1] + 3.4], desc, 1.2)));
          g.push(rg(e.id, sub));
        }
      }
      for (const p of s.pipes) {
        const a = nodePos.get(p.src), b = nodePos.get(p.tgt);
        if (!a || !b) { notes.push(`${p.id}: an end has no position; pipe not drawn.`); continue; }
        pipesDrawn++;
        const exact = routeInner(p.src, p.tgt) ?? drawnRoute(p.src, p.tgt, a, b);
        if (exact) routed++;
        // a pipe out of a jump arrow (it ends in a triangle and goes on at its label elsewhere on the
        // page): the PDF draws no line between the two, so neither does the diagram, only the drawn
        // stretch from the other end up to the label; the connection stays in the model
        else if (routers?.size && isJump(p)) {
          jumps++;
          pipesDrawn--;
          const [far, jmp] = jumpOf(p.src) ? [p.tgt, p.src] : [p.src, p.tgt];
          const ef = routeEnd(far, nodePos.get(far)!), ej = routeEnd(jmp, nodePos.get(jmp)!);
          const st = ef && ej && ef.page === ej.page && !jumpOf(far) ? routers.get(ef.page)?.stub(ef.end, ej.end) : null;
          if (st) g.push(rg(p.id, [stat({ t: "poly", pts: st.map((q) => toMM(ef!.page, q)), stroke: { c: C_LINE, w: 0.35 } })]));
          continue;
        }
        // no drawn line joins the ends: of the two knees take the one more on the drawn lines; a long
        // knee mostly off them would cross the sheet where the PDF has no line, so then only the
        // drawn stretches leaving each end toward the other are drawn
        let inner = exact;
        if (!inner && routers?.size) {
          const ea = routeEnd(p.src, a), eb = routeEnd(p.tgt, b);
          const R = ea && eb && ea.page === eb.page ? routers.get(ea.page) : undefined;
          if (R) {
            const off = pageOff.get(ea!.page) ?? 0;
            const px = (q: Pt): Pt => [q[0] / MM, (q[1] - off) / MM];
            // on a drawn line (a few px; a 1 mm tolerance did worse); thin and dashed lines count too (the model has some runs the
            // drawing shows as signal lines)
            const onAny = (q: Pt[]) => Math.max(R.onDrawn(q), R.signal?.onDrawn(q) ?? 0);
            const ks = [knee(a, b), knee(b, a)].map((k) => ({ k, on: onAny([a, ...k, b].map(px)) })).sort((x, y) => y.on - x.on);
            inner = ks[0].k;
            const on = ks[0].on;
            if ((legLen(p) ?? 0) >= KNEE_MAX * W && on < KNEE_ON) {
              longKnees++;
              pipesDrawn--;
              const parts = [R.stub(ea!.end, eb!.end), R.stub(eb!.end, ea!.end)].filter((x): x is Pt[] => !!x);
              if (parts.length) g.push(rg(p.id, parts.map((st) => stat({ t: "poly", pts: st.map((q) => toMM(ea!.page, q)), stroke: { c: C_LINE, w: 0.35 } }))));
              continue;
            }
          }
        }
        g.push(rg(p.id, [stat({ t: "conn", src: `${p.src}.pos`, tgt: `${p.tgt}.pos`, inner: inner ?? knee(a, b), stroke: { c: C_LINE, w: 0.35 } })]));
      }
      const groupsOut: G[] = [];
      if (si === 0) {
        const path = segPath.get(s.id)?.[0];
        if (path?.length) {
          const [A, B] = [path[0], path[1] ?? path[0]];
          groupsOut.push(label("PipingNetworkSystemLabel", text([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 0.8], l.label, 1.3, "CenterBottom", [{ attr: "LineNumber", obj: l.sys }])));
        }
      }
      segGroups.push(...groupsOut, rg(s.id, g, segSensing.get(s.id) ?? []));
    });
    groups.push(rg(l.sys, segGroups));
  }

  // ---- 7. instrumentation
  for (const ins of trace.instruments) {
    const it = items.get(ins.id);
    const r = rect(it);
    if (!it || !r) continue;
    const c = mid(r);
    const dia = Math.max(3, Math.min(14, Math.min(r[2] - r[0], r[3] - r[1])));
    const sc = dia / 11, R = 5.5 * sc;
    const ports: Record<string, Pt> = { top: [c[0], c[1] - R], bottom: [c[0], c[1] + R], left: [c[0] - R, c[1]], right: [c[0] + R, c[1]] };
    const letters = (it.type || "").toUpperCase();
    const tplA: Frag[] = [...(ins.category ? [{ attr: "ProcessInstrumentationFunctionCategory", obj: ins.id }] : []), ...(ins.functions ? [{ attr: "ProcessInstrumentationFunctions", obj: ins.id }] : [])];
    const g: G[] = [
      stat(use("ISA_BUBBLE_FIELD_SHAPE", c, 0, sc)),
      label(
        "ProcessInstrumentationFunctionLabel",
        text([c[0], c[1] - R * 0.35], letters, Math.max(1, R * 0.5), "CenterCenter", tplA.length ? tplA : undefined, C_TXT),
        text([c[0], c[1] + R * 0.4], it.loop ?? "", Math.max(1, R * 0.45), "CenterCenter", ins.number ? [{ attr: "ProcessInstrumentationFunctionNumber", obj: ins.id }] : undefined, C_TXT),
      ),
    ];
    const portToward = (p: Pt) => {
      const dx = p[0] - c[0], dy = p[1] - c[1];
      return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
    };
    const sp = sensePos.get(ins.id);
    if (sp) {
      const port = portToward(sp.p);
      const pp = ports[port];
      const inner: Pt[] = Math.abs(pp[0] - sp.p[0]) < GAP || Math.abs(pp[1] - sp.p[1]) < GAP ? [] : port === "left" || port === "right" ? [[sp.p[0], pp[1]]] : [[pp[0], sp.p[1]]];
      const drawn = sigEls(ins.mlVia);
      if (drawn) g.push(rg(ins.ml, drawn.length ? [stat(...drawn)] : []));
      else {
        const conn = (): El => ({ t: "conn", src: sp.id, tgt: `${ins.id}.${port}`, inner, stroke: { c: C_INSTR, w: 0.18 } });
        const R = routers?.get(it.page);
        // a measuring line of our own making, long and hardly on a drawn line: the PDF joins the bubble elsewhere
        // (a summing block, a motor, a valve's signal line). Drawn only as far as a drawn line leaves the bubble toward it.
        const pl = [sp.p, ...inner, pp];
        const len = pl.slice(1).reduce((s, q, i) => s + Math.abs(q[0] - pl[i][0]) + Math.abs(q[1] - pl[i][1]), 0);
        const off = pageOff.get(it.page) ?? 0;
        const px = pl.map((q): Pt => [q[0] / MM, (q[1] - off) / MM]);
        if (R && len >= ML_MAX * W && Math.max(R.onDrawn(px), R.signal?.onDrawn(px) ?? 0) < ML_ON) {
          longMl++;
          const from = { box: it.bbox }, to = { p: px[0] };
          const st = [R.stub(from, to), R.signal?.stub(from, to) ?? null].filter((x): x is Pt[] => !!x).sort((x, y) => plen(y) - plen(x))[0];
          g.push(rg(ins.ml, st ? [stat({ t: "poly", pts: st.map((q) => toMM(it.page, q)), stroke: { c: C_INSTR, w: 0.18 } })] : []));
        } else g.push(rg(ins.ml, [stat(conn())]));
      }
    }
    for (const s of ins.sigs) {
      const drawn = sigEls(s.via);
      if (drawn) {
        g.push(rg(s.id, drawn.length ? [stat(...drawn)] : []));
        continue;
      }
      // a link inferred from the loop number has no line on the drawing: kept in DEXPI, not drawn
      if (s.inferred) {
        g.push(rg(s.id, []));
        continue;
      }
      const tr = rect(items.get(s.target));
      if (!tr) continue;
      const tc = mid(tr);
      const port = portToward(tc), pp = ports[port];
      const back = Math.abs(tc[0] - c[0]) >= Math.abs(tc[1] - c[1]) ? (tc[0] > c[0] ? "left" : "right") : tc[1] > c[1] ? "top" : "bottom";
      const tdia = Math.max(3, Math.min(14, Math.min(tr[2] - tr[0], tr[3] - tr[1])));
      const tR = (5.5 * tdia) / 11;
      const tp: Pt = back === "left" ? [tc[0] - tR, tc[1]] : back === "right" ? [tc[0] + tR, tc[1]] : back === "top" ? [tc[0], tc[1] - tR] : [tc[0], tc[1] + tR];
      // a signal the model saw but no drawn signal line was linked to: along the thin and dashed drawn lines (the rest as a knee)
      const ti = items.get(s.target)!, SR = routers?.get(it.page)?.signal;
      const sr = SR && ti.page === it.page ? SR.route({ box: it.bbox }, { box: ti.bbox }) : null;
      const along = sr && sr.length >= 2 ? sr.map((q) => toMM(it.page, q)) : null;
      if (along) sigRouted++;
      g.push(rg(s.id, [stat({ t: "conn", src: `${ins.id}.${port}`, tgt: `${s.target}.${back}`, inner: along ?? knee(pp, tp), stroke: { c: C_SIG, w: 0.18, dash: "Dash" } })]));
    }
    for (const a of ins.acts) {
      const v = trace.lines.flatMap((l) => l.elems).find((e) => e.kind === "comp" && e.id === a.valve) as Extract<TraceElem, { kind: "comp" }> | undefined;
      if (!v || !nodePos.has(v.n1)) continue;
      const n1 = nodePos.get(v.n1)!, n2 = nodePos.get(v.n2)!;
      const vc: Pt = [(n1[0] + n2[0]) / 2, (n1[1] + n2[1]) / 2];
      const horiz = Math.abs(n2[0] - n1[0]) >= Math.abs(n2[1] - n1[1]);
      const top: Pt = horiz ? [vc[0], vc[1] - 3] : [vc[0] - 3, vc[1]];
      const port = portToward(top);
      const pp = ports[port];
      const inner: Pt[] = Math.abs(pp[0] - top[0]) < GAP || Math.abs(pp[1] - top[1]) < GAP ? [] : port === "left" || port === "right" ? [[top[0], pp[1]]] : [[pp[0], top[1]]];
      const drawn = sigEls(a.via);
      g.push(rg(a.sl, drawn ? (drawn.length ? [stat(...drawn)] : []) : [stat({ t: "conn", src: `${ins.id}.${port}`, tgt: `${a.as}.act`, inner, stroke: { c: C_SIG, w: 0.18, dash: "Dash" } })]));
      groups.push(
        rg(a.as, [
          label("ActuatingSystemNumberLabel", text([top[0] + 1.5, top[1] - 1], a.number, 1.1, "LeftCenter", [{ attr: "ActuatingSystemNumber", obj: a.as }])),
          rg(a.ca, [stat(use("ISA_DIAPHRAGM_ACTUATOR_SHAPE", vc, horiz ? 0 : 270, 0.35))], [{ id: `${a.as}.act`, kind: "instr", p: top }]),
        ]),
      );
    }
    groups.push(rg(ins.id, g, Object.entries(ports).map(([k, p]) => ({ id: `${ins.id}.${k}`, kind: "instr" as const, p }))));
  }

  // drawn signal lines that carry no recorded signal: kept as plain graphics
  const loose: El[] = [];
  for (const sl of sigLines.values()) if (!sigDrawn.has(sl.id)) loose.push(...(sigEls(sl.id) ?? []));
  if (loose.length) groups.push(stat(...loose));
  if (routes.size || routers?.size) notes.push(`${routed} of ${pipesDrawn} pipes drawn along their PDF route (${partlyRouted} of them partly: the drawn line followed as far as it goes, the rest as a knee), ${teesDrawn} tees where the drawn branch meets its run;${jumps ? ` ${jumps} pipes across a jump arrow left undrawn, as in the PDF;` : ""}${longKnees ? ` ${longKnees} long unrouted pipes drawn only where the drawn line leaves their ends;` : ""}${longMl ? ` ${longMl} long made-up measuring lines drawn only where a drawn line leaves the bubble;` : ""} ${sigDrawn.size} drawn signal lines, ${sigRouted} signals along thin drawn lines.${kneeWhy.size ? ` Not routed: ${[...kneeWhy].map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""}`);

  // ---- 8. frame and provenance
  const m = 3;
  const tb = model.title_block;
  groups.push({ type: "Core/Diagram.Border", els: [{ t: "poly", pts: [[m, m], [W - m, m], [W - m, H - m], [m, H - m], [m, m]], stroke: { c: [0, 0, 0], w: 0.35 } }] });
  groups.push({
    type: "Core/Diagram.Label",
    els: [text([m + 2, H - m - 2], `${tb.drawing_number ?? model.document} — digitised from PDF by pid-to-dexpi; positions from the source PDF; symbols DEXPI 2.0.1 reference (CC BY 4.0) / FlowBite. Draft — engineer review required.`, 1.8, "LeftBottom")],
  });

  return { groups, W, H, usedShapes, notes, name: tb.drawing_number ?? model.document };
}

// ---------- serialisation: DEXPI XML ----------
function elXml(e: El): Node {
  if (e.t === "use")
    return obj("Core/Diagram.ShapeUsage", null, [bool("IsMirrored", false), data("Position", point(...e.p)), dbl("Rotation", e.rot), dbl("ScaleX", e.sx), dbl("ScaleY", e.sy), ref("Shape", `SYM.${e.shape}`)!]);
  if (e.t === "text") {
    const frags = (e.tpl ?? []).map((f) =>
      "attr" in f
        ? obj("Core/Diagram.AttributeRepresentation", null, [str("AttributeName", f.attr)!, enumRef("Type", "Core/Diagram.AttributeRepresentationType.Value"), ref("Object", f.obj)!])
        : obj("Core/Diagram.LiteralText", null, [str("Text", f.lit)!]),
    );
    return obj("Core/Diagram.Text", null, nn([
      enumRef("Alignment", `Core/Diagram.TextAlignment.${e.align}`),
      data("Color", color(e.color)),
      str("Font", "Arial"),
      data("Position", point(...e.p)),
      dbl("Rotation", 0),
      dbl("Size", e.size),
      frags.length ? comps("Template", [obj("Core/Diagram.TextTemplate", null, [comps("Fragments", frags)!])]) : null,
      `<Data property="Text"><String>${esc(e.s)}</String></Data>`,
    ]));
  }
  if (e.t === "conn")
    return obj("Core/Diagram.ConnectorLine", null, nn([
      e.inner.length ? data("InnerPoints", ...e.inner.map((p) => point(...p))) : null,
      data("Stroke", stroke(e.stroke.c, e.stroke.w, e.stroke.dash)),
      ref("Source", e.src), ref("Target", e.tgt),
    ]));
  return obj("Core/Diagram.PolyLine", null, [data("Points", ...e.pts.map((p) => point(...p))), data("Stroke", stroke(e.stroke.c, e.stroke.w, e.stroke.dash))]);
}
function npXml(n: NP): Node {
  return n.kind === "piping"
    ? obj("Plant/Diagram.PipingNodePosition", n.id, nn([data("Position", point(...n.p)), ref("Node", n.node)]))
    : obj("Plant/Diagram.InstrumentationNodePosition", n.id, [data("Position", point(...n.p))]);
}
function gXml(g: G): Node {
  if (g.type === "Core/Diagram.RepresentationGroup")
    return obj(g.type, null, nn([comps("Groups", (g.groups ?? []).map(gXml)), comps("NodePositions", (g.nodes ?? []).map(npXml)), ref("Represents", g.represents)]));
  return obj(g.type, null, nn([comps("Elements", (g.els ?? []).map(elXml))]));
}

export function diagramXml(d: ReturnType<typeof buildDiagram>) {
  const L = lib();
  const diagram = obj("Core/Diagram.Diagram", null, nn([
    data("BackgroundColor", color([255, 255, 255])),
    comps("Groups", d.groups.map(gXml)),
    dbl("MaxX", d.W), dbl("MaxY", d.H), dbl("MinX", 0), dbl("MinY", 0),
    str("Name", d.name),
    ref("Represents", "PlantModel1"),
  ]));
  const shapes = [...d.usedShapes].sort().map((s) => L.symbols[s].xml.replace('<Object type="Core/Diagram.Shape">', `<Object id="SYM.${s}" type="Core/Diagram.Shape">`));
  const catalogue = obj("Core/Diagram.ShapeCatalogue", null, nn([
    str("Name", `pid-to-dexpi symbols — ${L.license}`),
    comps("Shapes", shapes),
  ]));
  return { diagram, catalogue };
}

// ---------- serialisation: SVG preview ----------
interface X { tag: string; attrs: Record<string, string>; kids: X[]; text: string }
function parseXml(s: string): X {
  const root: X = { tag: "#root", attrs: {}, kids: [], text: "" };
  const stack = [root];
  for (const m of s.matchAll(/<(\/?)([\w:.]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.text += m[5]; continue; }
    if (m[1]) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const x: X = { tag: m[2], attrs, kids: [], text: "" };
    top.kids.push(x);
    if (!m[4]) stack.push(x);
  }
  return root;
}
const prop = (x: X, name: string) => x.kids.find((k) => k.tag === "Data" && k.attrs.property === name);
const numOf = (x: X | undefined) => Number(x?.kids[0]?.text ?? 0);
const ptOf = (agg: X): Pt => [numOf(prop(agg, "X")), numOf(prop(agg, "Y"))];
function strokeOf(x: X) {
  const s = prop(x, "Stroke")?.kids[0];
  if (!s) return { c: "#000", w: 0.25, dash: "" };
  const c = prop(s, "Color")?.kids[0];
  const rgb = c ? [numOf(prop(c, "R")), numOf(prop(c, "G")), numOf(prop(c, "B"))] : [0, 0, 0];
  const dash = prop(s, "DashStyle")?.kids[0]?.attrs.data ?? "";
  return { c: `rgb(${rgb.join(",")})`, w: numOf(prop(s, "Width")) || 0.25, dash: dash && !dash.endsWith(".Solid") ? ' stroke-dasharray="1.2 0.6"' : "" };
}
function shapeSvg(xml: string): string {
  const shape = parseXml(xml).kids[0];
  const prims = shape.kids.find((k) => k.tag === "Components" && k.attrs.property === "Primitives")?.kids ?? [];
  const out: string[] = [];
  for (const p of prims) {
    const st = strokeOf(p);
    const fill = prop(p, "FillStyle")?.kids[0]?.attrs.data?.endsWith("Solid") ? st.c : "none";
    const attrs = `stroke="${st.c}" stroke-width="${st.w}" fill="${fill}"${st.dash}`;
    const type = p.attrs.type;
    if (type === "Core/Diagram.PolyLine") {
      const pts = (prop(p, "Points")?.kids ?? []).map(ptOf);
      out.push(`<polyline points="${pts.map((q) => q.join(",")).join(" ")}" ${attrs}/>`);
    } else if (type === "Core/Diagram.Ellipse" || type === "Core/Diagram.EllipseArc") {
      const [cx, cy] = ptOf(prop(p, "Center")!.kids[0]);
      const rx = numOf(prop(p, "HorizontalSemiAxis")), ry = numOf(prop(p, "VerticalSemiAxis"));
      const rot = numOf(prop(p, "Rotation"));
      if (type === "Core/Diagram.Ellipse") out.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})" ${attrs}/>`);
      else {
        let a0 = numOf(prop(p, "StartAngle")), a1 = numOf(prop(p, "EndAngle"));
        if (a1 < a0) a1 += 360;
        const pts: string[] = [];
        for (let k = 0; k <= 24; k++) {
          const a = ((a0 + ((a1 - a0) * k) / 24) * Math.PI) / 180;
          pts.push(`${(cx + rx * Math.cos(a)).toFixed(3)},${(cy + ry * Math.sin(a)).toFixed(3)}`);
        }
        out.push(`<polyline points="${pts.join(" ")}" transform="rotate(${rot} ${cx} ${cy})" ${attrs}/>`);
      }
    }
  }
  return out.join("");
}

const ANCHOR: Record<string, [string, string]> = {
  Left: ["start", ""], Center: ["middle", ""], Right: ["end", ""],
};
export function diagramSvg(d: ReturnType<typeof buildDiagram>) {
  const L = lib();
  const pos = new Map<string, Pt>();
  const walkPos = (g: G) => { for (const n of g.nodes ?? []) pos.set(n.id, n.p); (g.groups ?? []).forEach(walkPos); };
  d.groups.forEach(walkPos);
  const body: string[] = [];
  const rgb = (c: RGB) => `rgb(${c.join(",")})`;
  const walk = (g: G, rep?: string) => {
    const r = g.represents ?? rep;
    for (const e of g.els ?? []) {
      if (e.t === "use") body.push(`<use href="#${e.shape}" transform="translate(${e.p[0].toFixed(3)} ${e.p[1].toFixed(3)}) rotate(${e.rot}) scale(${e.sx.toFixed(4)} ${e.sy.toFixed(4)})"${r ? ` data-id="${esc(r)}"` : ""}/>`);
      else if (e.t === "text") {
        const m = e.align.match(/^(Left|Center|Right)(Top|Center|Bottom)$/) ?? ["", "Center", "Center"];
        const base = m[2] === "Top" ? "hanging" : m[2] === "Center" ? "central" : "alphabetic";
        body.push(`<text x="${e.p[0].toFixed(3)}" y="${e.p[1].toFixed(3)}" font-size="${e.size.toFixed(2)}" text-anchor="${ANCHOR[m[1]][0]}" dominant-baseline="${base}" fill="${rgb(e.color)}">${esc(e.s)}</text>`);
      } else if (e.t === "conn") {
        const a = pos.get(e.src), b = pos.get(e.tgt);
        if (!a || !b) continue;
        const pts = [a, ...e.inner, b].map((q) => `${q[0].toFixed(3)},${q[1].toFixed(3)}`).join(" ");
        body.push(`<polyline points="${pts}" fill="none" stroke="${rgb(e.stroke.c)}" stroke-width="${e.stroke.w}"${e.stroke.dash === "Dash" ? ' stroke-dasharray="1.2 0.6"' : ""}${r ? ` data-id="${esc(r)}"` : ""}/>`);
      } else body.push(`<polyline points="${e.pts.map((q) => `${q[0].toFixed(3)},${q[1].toFixed(3)}`).join(" ")}" fill="none" stroke="${rgb(e.stroke.c)}" stroke-width="${e.stroke.w}"${e.stroke.dash === "Dash" ? ' stroke-dasharray="1.2 0.6"' : ""}${r ? ` data-id="${esc(r)}"` : ""}/>`);
    }
    for (const c of g.groups ?? []) walk(c, r);
  };
  d.groups.forEach((g) => walk(g));
  const defs = [...d.usedShapes].map((s) => `<g id="${s}">${shapeSvg(L.symbols[s].xml)}</g>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.W.toFixed(1)} ${d.H.toFixed(1)}" width="${d.W.toFixed(1)}mm" height="${d.H.toFixed(1)}mm" font-family="Arial, sans-serif">
<rect width="100%" height="100%" fill="#fff"/>
<defs>
${defs}
</defs>
${body.join("\n")}
</svg>
`;
}
