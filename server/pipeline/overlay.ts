import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { BBox, DrawingModel } from "../types.ts";
import type { RunContext } from "./context.ts";
import { computeNets, loadVector } from "./vectorlayer.ts";
import { ROOT } from "../config.ts";

/** per drawing: solid line widths that are no process lines (reference/overlay-legend.json) */
function notPipeWidths(project: string): [number, number][] {
  try {
    const legend = JSON.parse(fs.readFileSync(path.join(ROOT, "reference", "overlay-legend.json"), "utf8"));
    return (legend[project]?.notPipe ?? []).map((x: { w: [number, number] }) => x.w);
  } catch {
    return [];
  }
}

/**
 * Overlay score: how well our DEXPI drawing lies on the PDF. The DEXPI preview (SVG, millimetres,
 * pages stacked) is mapped back to page pixels and laid over the drawn lines of the PDF (vector
 * layer, CAD PDFs only). No model calls.
 *
 *  - precision: of the lines we draw (pipes, measuring and signal lines), the share that lies on a
 *    drawn stroke of the PDF — the rest is invented (a knee where the pipe runs straight, a pipe
 *    across empty paper between two items that are not joined);
 *  - pipe recall: of the drawn process lines of the PDF (solid nets reaching at least one symbol),
 *    the share we draw too — the rest is missed;
 *  - signal recall: the same for the dashed lines.
 * Samples inside symbol boxes do not count (there our line passes a library symbol).
 */

type Pt = [number, number];
interface OurLine { id: string | null; kind: "pipe" | "instrument" | "signal"; page: number; pts: Pt[] }
export interface OverlayMiss { page: number; bbox: BBox; length: number; touches: string[] }
/** every drawn process net: its length and how much of it we miss (px), for the loss analysis */
export interface OverlayNetMiss { page: number; net: string; dash: boolean; drawn: number; missed: number; /** missed px per piece of net.path */ pieces: number[] }
export interface OverlayExtra { page: number; id: string | null; kind: string; length: number; bbox: BBox }
export interface OverlayPage {
  n: number;
  precision: number | null;
  pipeRecall: number | null;
  signalRecall: number | null;
  ours: number; // px of our lines sampled (outside symbols)
  drawnPipe: number; // px of drawn process line
  drawnSignal: number;
}
export interface OverlayResult {
  vector: boolean;
  pages: OverlayPage[];
  precision: number | null;
  pipeRecall: number | null;
  signalRecall: number | null;
  misses: OverlayMiss[];
  extras: OverlayExtra[];
  nets: OverlayNetMiss[];
  /** px of drawn solid line not counted as pipe because the drawing's legend says it is none */
  ignored: number;
}

const STEP_MM = 0.5;

/** Our drawn lines from the DEXPI preview, in page pixels. */
function ourLines(svg: string, model: DrawingModel): OurLine[] {
  const MM = 25.4 / (model.dpi || 200);
  const offs: { n: number; y0: number; y1: number }[] = [];
  let y = 0;
  for (const p of [...model.pages].sort((a, b) => a.n - b.n)) {
    offs.push({ n: p.n, y0: y, y1: y + p.px[1] * MM });
    y += p.px[1] * MM + 10;
  }
  const body = svg.slice(svg.indexOf("</defs>"));
  const out: OurLine[] = [];
  for (const m of body.matchAll(/<polyline points="([^"]+)"[^>]*?stroke="rgb\((\d+),(\d+),(\d+)\)"[^>]*?(?:data-id="([^"]*)")?\/>/g)) {
    const mm = m[1].trim().split(/\s+/).map((s) => s.split(",").map(Number) as Pt);
    if (mm.length < 2) continue;
    const pg = offs.find((o) => mm[0][1] >= o.y0 - 1 && mm[0][1] <= o.y1 + 1);
    if (!pg) continue;
    const [r, g, b] = [m[2], m[3], m[4]].map(Number);
    const kind = r === 40 && g === 40 && b === 40 ? "pipe" : g === 128 && r === 0 ? "instrument" : b === 200 ? "signal" : null;
    if (!kind) continue;
    out.push({ id: m[5] ?? null, kind, page: pg.n, pts: mm.map((q) => [q[0] / MM, (q[1] - pg.y0) / MM]) });
  }
  return out;
}

/** Points every `step` px along a polyline. */
function samples(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [a, b] = [pts[k], pts[k + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / step));
    for (let i = k ? 1 : 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}

/** Grid of segments for "is there a stroke within tol of this point". */
/** least drawn signal line (px) for a signal recall */
const MIN_SIGNAL = 200;

class SegGrid {
  private cells = new Map<string, [Pt, Pt][]>();
  constructor(private cell: number) {}
  add(a: Pt, b: Pt) {
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])].map((v) => Math.floor(v / this.cell));
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])].map((v) => Math.floor(v / this.cell));
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const l = this.cells.get(k);
        if (l) l.push([a, b]);
        else this.cells.set(k, [[a, b]]);
      }
  }
  near(p: Pt, tol: number): boolean {
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    const r = Math.ceil(tol / this.cell);
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (const [a, b] of this.cells.get(`${x},${y}`) ?? []) {
          const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
          if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= tol) return true;
        }
    return false;
  }
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const bboxOf = (pts: Pt[]): BBox => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))].map(Math.round) as BBox;

export function overlayScore(ctx: RunContext, model: DrawingModel, svg: string, pngDir?: string): Promise<OverlayResult> | OverlayResult {
  const dir = ctx.dir;
  const pages = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
  const v = loadVector(ctx, pages);
  const vecPages = pages.filter((p) => v.get(p.n)?.kind === "vector");
  const empty: OverlayResult = { vector: false, pages: [], precision: null, pipeRecall: null, signalRecall: null, misses: [], extras: [], nets: [], ignored: 0 };
  if (!vecPages.length) return empty;
  const nets = computeNets(ctx, model, pages);
  const lines = ourLines(svg, model);
  const px = (model.dpi || 200) / 25.4; // px per mm
  const tol = 1.0 * px, step = STEP_MM * px;
  const res: OverlayResult = { ...empty, vector: true };
  const draw: { n: number; W: number; H: number; file: string; ok: Pt[][]; extra: Pt[][]; miss: Pt[][] }[] = [];
  let [hit, ours, pr, pAll, sr, sAll] = [0, 0, 0, 0, 0, 0];

  for (const pg of vecPages) {
    const vp = v.get(pg.n)!;
    const boxes = model.items.filter((i) => i.page === pg.n).map((i) => i.bbox);
    // the outline of an apparatus (shell, legs, internals) is not a pipe either
    const eqBoxes = model.items.filter((i) => i.page === pg.n && i.category === "equipment").map((i) => i.bbox);
    const nearEquipment = (p: Pt) => eqBoxes.some((b) => p[0] > b[0] - 2 * px && p[0] < b[2] + 2 * px && p[1] > b[1] - 2 * px && p[1] < b[3] + 2 * px);
    const inSymbol = (p: Pt) => boxes.some((b) => p[0] > b[0] + 1 && p[0] < b[2] - 1 && p[1] > b[1] + 1 && p[1] < b[3] - 1);
    // everything drawn on the sheet that is a stroke (not a bubble arc): what our lines may lie on
    const drawn = new SegGrid(40);
    for (const s of vp.segs) if (!s.curve) drawn.add(s.a, s.b);
    // our lines
    const mine = new SegGrid(40);
    const pageLines = lines.filter((l) => l.page === pg.n);
    const ok: Pt[][] = [], extra: Pt[][] = [];
    let [h, o] = [0, 0];
    for (const l of pageLines) {
      for (let k = 0; k + 1 < l.pts.length; k++) mine.add(l.pts[k], l.pts[k + 1]);
      let off = 0, run: Pt[] = [], state: boolean | null = null;
      const flush = () => {
        if (run.length >= 2) (state ? ok : extra).push(run);
        run = [];
      };
      for (const p of samples(l.pts, step)) {
        if (inSymbol(p)) {
          flush();
          state = null;
          continue;
        }
        const on = drawn.near(p, tol);
        if (state !== null && on !== state) {
          const last = run[run.length - 1];
          flush();
          if (last) run.push(last);
        }
        state = on;
        run.push(p);
        o++;
        if (on) h++;
        else off++;
      }
      flush();
      if (off * step >= 40)
        res.extras.push({ page: pg.n, id: l.id, kind: l.kind, length: Math.round(off * step), bbox: bboxOf(l.pts) });
    }
    // drawn process lines: nets reaching a symbol — directly, ending just short of one (an arrowhead in
    // between), or through other lines that do. The frame, title block and legend are not process lines.
    const pageNets = nets.get(pg.n) ?? [];
    const gap = (q: Pt, b: BBox) => Math.hypot(Math.max(b[0] - q[0], 0, q[0] - b[2]), Math.max(b[1] - q[1], 0, q[1] - b[3]));
    // a line across most of the sheet is the frame or a zone divider, never a pipe
    const sheetWide = new Set(pageNets.filter((x) => x.bbox[2] - x.bbox[0] > 0.6 * pg.W || x.bbox[3] - x.bbox[1] > 0.6 * pg.H).map((x) => x.id));
    // a tag's label frame and its leader line are annotation, not process lines
    const labels = model.items.filter((i) => i.page === pg.n && i.label_box).map((i) => i.label_box!);
    for (const x of pageNets)
      if (labels.some((b) => x.len <= 4 * (b[2] - b[0]) && x.path.some(([a, c]) => [a, c].some((q) => gap(q, b) <= Math.max(12, 0.6 * (b[3] - b[1])))))) sheetWide.add(x.id);
    // text drawn as vector strokes: the strokes of a line of letters line up and are read as dashes.
    // A small dashed "net" whose pieces lie on three or more parallel rows is lettering, not a line
    for (const x of pageNets) {
      if (!x.dash || Math.max(x.bbox[2] - x.bbox[0], x.bbox[3] - x.bbox[1]) >= 0.03 * pg.W) continue;
      const hr = new Set<number>(), vr = new Set<number>();
      for (const [a, b] of x.path)
        if (Math.abs(a[1] - b[1]) < 1.5) hr.add(Math.round(a[1] / 3));
        else if (Math.abs(a[0] - b[0]) < 1.5) vr.add(Math.round(a[0] / 3));
      if (Math.max(hr.size, vr.size) >= 3) sheetWide.add(x.id);
    }
    const notPipe = notPipeWidths(ctx.state.project);
    for (const x of pageNets)
      if (!x.dash && notPipe.some(([lo, hi]) => x.w >= lo && x.w <= hi)) {
        sheetWide.add(x.id);
        res.ignored += Math.round(x.len);
      }
    const process = new Set(pageNets.filter((x) => !sheetWide.has(x.id) && (x.touches.length || x.ends.some((q) => boxes.some((b) => gap(q, b) <= 3 * px)))).map((x) => x.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of pageNets) {
        if (process.has(x.id) || sheetWide.has(x.id)) continue;
        if (x.attaches.some((a) => process.has(a.net)) || pageNets.some((y) => process.has(y.id) && y.attaches.some((a) => a.net === x.id))) {
          process.add(x.id);
          grew = true;
        }
      }
    }
    const miss: Pt[][] = [];
    let [ph, pa, sh, sa] = [0, 0, 0, 0];
    for (const net of pageNets) {
      if (!process.has(net.id)) continue;
      let netMiss = 0, netAll = 0;
      const pieceMiss: number[] = [];
      for (const [a, b] of net.path) {
        const before = netMiss;
        let run: Pt[] = [];
        for (const p of samples([a, b], step)) {
          if (inSymbol(p) || nearEquipment(p)) continue;
          const on = mine.near(p, tol);
          netAll++;
          if (net.dash) [sh, sa] = [sh + (on ? 1 : 0), sa + 1];
          else [ph, pa] = [ph + (on ? 1 : 0), pa + 1];
          if (!on) {
            run.push(p);
            netMiss++;
          } else if (run.length) {
            if (run.length >= 2) miss.push(run);
            run = [];
          }
        }
        if (run.length >= 2) miss.push(run);
        pieceMiss.push(Math.round((netMiss - before) * step));
      }
      res.nets.push({ page: pg.n, net: net.id, dash: net.dash, drawn: Math.round(netAll * step), missed: Math.round(netMiss * step), pieces: pieceMiss });
      if (netMiss * step >= 40) res.misses.push({ page: pg.n, bbox: net.bbox as BBox, length: Math.round(netMiss * step), touches: net.touches.map((t) => t.item) });
    }
    res.pages.push({ n: pg.n, precision: ratio(h, o), pipeRecall: ratio(ph, pa), signalRecall: sa * step >= MIN_SIGNAL ? ratio(sh, sa) : null, ours: Math.round(o * step), drawnPipe: Math.round(pa * step), drawnSignal: Math.round(sa * step) });
    [hit, ours, pr, pAll, sr, sAll] = [hit + h, ours + o, pr + ph, pAll + pa, sr + sh, sAll + sa];
    draw.push({ n: pg.n, W: pg.W, H: pg.H, file: pg.file, ok, extra, miss });
  }
  res.precision = ratio(hit, ours);
  res.pipeRecall = ratio(pr, pAll);
  // a few short stretches are no basis for a score
  res.signalRecall = sAll * step >= MIN_SIGNAL ? ratio(sr, sAll) : null;
  res.misses.sort((a, b) => b.length - a.length);
  res.extras.sort((a, b) => b.length - a.length);
  if (!pngDir) return res;
  return (async () => {
    for (const d of draw) await overlayPng(d, path.join(pngDir, `overlay-p${d.n}.png`));
    return res;
  })();
}

/** The page faded, with our lines on top: green on the drawing, red invented; blue drawn but missed. */
async function overlayPng(d: { W: number; H: number; file: string; ok: Pt[][]; extra: Pt[][]; miss: Pt[][] }, out: string) {
  const s = Math.min(1, 2400 / d.W);
  const W = Math.round(d.W * s), H = Math.round(d.H * s);
  const pl = (runs: Pt[][], c: string, w: number) => runs.map((r) => `<polyline points="${r.map((p) => `${(p[0] * s).toFixed(1)},${(p[1] * s).toFixed(1)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${pl(d.miss, "#1f6fff", 5)}${pl(d.ok, "#18a058", 3)}${pl(d.extra, "#e5332a", 4)}</svg>`);
  const base = await sharp(d.file).resize(W, H).grayscale().linear(0.35, 255 * 0.65).toBuffer();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(base).composite([{ input: svg }]).png().toFile(out);
}

/** Score the project's current DEXPI preview and write overlay.json + overlay-p<n>.png beside it. */
export async function writeOverlay(ctx: RunContext, model: DrawingModel): Promise<OverlayResult | null> {
  const svgFile = path.join(ctx.dir, `${ctx.state.project}.dexpi.svg`);
  if (!fs.existsSync(svgFile)) return null;
  const r = await overlayScore(ctx, model, fs.readFileSync(svgFile, "utf8"), ctx.dir);
  if (r.vector) fs.writeFileSync(path.join(ctx.dir, "overlay.json"), JSON.stringify(r, null, 2));
  return r;
}

export const overlaySummary = (r: OverlayResult) => {
  const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  return `precision ${pct(r.precision)} (our lines on the drawing), pipe recall ${pct(r.pipeRecall)}, signal recall ${pct(r.signalRecall)} (drawn lines we draw too)`;
};
