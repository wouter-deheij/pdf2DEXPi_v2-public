/**
 * Compare two readings of the same drawing (e.g. before and after a pipeline change), without model calls.
 * Usage: npm run compare -- <old project dir> <new project dir>
 * Counts per category, runs, open run ends, links, unlinked instruments, open points, and how well the
 * runs agree with the drawn lines of the PDF (vector layer, each model with its own item boxes).
 * When the project's answer key has counted totals (key.counts), both readings are held against them.
 */
import fs from "node:fs";
import path from "node:path";
import type { DrawingModel, RunState } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import type { PageImage } from "./pipeline/locate.ts";
import { computeNets, netAgreement } from "./pipeline/vectorlayer.ts";
import { checkCounts, readKey } from "./pipeline/answerkey.ts";
import { overlayScore } from "./pipeline/overlay.ts";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: npm run compare -- <old project dir> <new project dir>");
  process.exit(1);
}

async function measure(dir: string) {
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunState;
  const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  const ctx = new RunContext(dir, run.settings, { ...run, log: [] });
  ctx.persist = () => {};
  ctx.writeJSON = () => {}; // read-only
  const pages: PageImage[] = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
  const agree = netAgreement(model, computeNets(ctx, model, pages));
  const cat = (c: string) => model.items.filter((i) => i.category === c).length;
  const linked = new Set(model.signals.flatMap((s) => [s.instrument, s.target])); // either end of a signal
  const svg = path.join(dir, `${path.basename(dir)}.dexpi.svg`);
  const ov = fs.existsSync(svg) ? await overlayScore(ctx, model, fs.readFileSync(svg, "utf8")) : null;
  const pct = (v: number | null | undefined) => (v === null || v === undefined || !ov?.vector ? "—" : `${(v * 100).toFixed(1)}%`);
  const answer = fs.existsSync(path.join(dir, "drawing.answer.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "drawing.answer.json"), "utf8")) : {};
  return {
    "cost $": +run.usage.cost_usd.toFixed(2),
    confidence: answer.confidence ?? run.score ?? null,
    equipment: cat("equipment"),
    instruments: cat("instrument"),
    valves: cat("valve"),
    "piping components": cat("piping_component"),
    "off-page": cat("off_page"),
    runs: model.lines.length,
    "open run ends": model.lines.reduce((s, l) => s + +(l.from.kind === "open") + +(l.to.kind === "open"), 0),
    "components on runs": model.lines.reduce((s, l) => s + l.components.length, 0),
    "instrument links": model.signals.length,
    "instruments without link": model.items.filter((i) => i.category === "instrument" && !linked.has(i.id)).length,
    "open points": model.ambiguities.length,
    "pairs confirmed by drawn lines": `${agree.ok}/${agree.pairs} (${agree.share})`,
    "overlay precision": pct(ov?.precision),
    "overlay pipe recall": pct(ov?.pipeRecall),
    "overlay signal recall": pct(ov?.signalRecall),
  };
}

const x = await measure(path.resolve(a)), y = await measure(path.resolve(b));
const w = Math.max(...Object.keys(x).map((k) => k.length));
console.log(`${"".padEnd(w)}  ${"old".padStart(14)}  ${"new".padStart(14)}`);
for (const k of Object.keys(x) as (keyof typeof x)[]) console.log(`${k.padEnd(w)}  ${String(x[k]).padStart(14)}  ${String(y[k]).padStart(14)}`);

const counts = readKey(path.basename(path.resolve(b)))?.counts;
if (counts) {
  const model = (d: string) => JSON.parse(fs.readFileSync(path.join(path.resolve(d), "drawing.model.json"), "utf8")) as DrawingModel;
  const ca = checkCounts(counts, model(a)), cb = checkCounts(counts, model(b));
  const mark = (s: string) => (s === "ok" ? "✓" : s === "near" ? "~" : "✗");
  console.log(`\nreference counts (${counts.source}, ${counts.date})`);
  console.log(`${"".padEnd(w)}  ${"old".padStart(14)}  ${"new".padStart(14)}  ${"counted".padStart(8)}`);
  const whats = [...new Set([...ca.rows, ...cb.rows].map((r) => r.what))];
  for (const what of whats) {
    const ra = ca.rows.find((r) => r.what === what), rb = cb.rows.find((r) => r.what === what);
    const exp = (rb ?? ra)!.expected;
    const cell = (r?: { found: number; status: string }) => (r ? `${r.found} ${mark(r.status)}` : `0 ${mark(exp === 0 ? "ok" : "off")}`);
    console.log(`${what.padEnd(w)}  ${cell(ra).padStart(14)}  ${cell(rb).padStart(14)}  ${String(exp).padStart(8)}`);
  }
  console.log(`${"verdict".padEnd(w)}  ${(ca.ok ? "ok" : "off").padStart(14)}  ${(cb.ok ? "ok" : "off").padStart(14)}`);
}
