/**
 * Overlay score: how well the DEXPI drawing lies on the PDF (vector pages only, no model calls).
 *   npm run overlay                        every project
 *   npm run overlay -- <project> [-v]      -v lists the largest missed and invented stretches
 * Writes output/<project>/overlay.json and overlay-p<n>.png (page faded; green = our line on the
 * drawing, red = our line where nothing is drawn, blue = drawn process line we do not draw).
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import { overlayScore } from "./pipeline/overlay.ts";

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const names = args.filter((a) => !a.startsWith("-"));
const projects = names.length ? names : fs.readdirSync(OUTPUT_DIR).filter((d) => fs.existsSync(path.join(OUTPUT_DIR, d, "drawing.model.json")));
const pct = (x: number | null) => (x === null ? "  —  " : `${(x * 100).toFixed(1).padStart(5)}%`);

console.log(`${"project".padEnd(48)} precision  pipe recall  signal recall   (drawn pipe / signal, m on paper)`);
for (const p of projects) {
  const dir = path.join(OUTPUT_DIR, p);
  const svgFile = path.join(dir, `${p}.dexpi.svg`);
  if (!fs.existsSync(svgFile)) {
    console.log(`${p.padEnd(48)} no DEXPI preview — run redexpi first`);
    continue;
  }
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [] });
  ctx.persist = () => {};
  const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  const r = await overlayScore(ctx, model, fs.readFileSync(svgFile, "utf8"), dir);
  if (!r.vector) {
    console.log(`${p.padEnd(48)} scanned sheet — no vector layer to compare with`);
    continue;
  }
  fs.writeFileSync(path.join(dir, "overlay.json"), JSON.stringify(r, null, 2));
  const mm = 25.4 / (model.dpi || 200) / 1000;
  const len = (k: "drawnPipe" | "drawnSignal") => (r.pages.reduce((s, x) => s + x[k], 0) * mm).toFixed(1);
  console.log(`${p.padEnd(48)}   ${pct(r.precision)}      ${pct(r.pipeRecall)}        ${pct(r.signalRecall)}        ${len("drawnPipe")} / ${len("drawnSignal")}`);
  if (verbose) {
    for (const m of r.misses.slice(0, 10)) console.log(`   missed   p${m.page} ${String(m.length).padStart(5)} px at ${m.bbox.join(",")}  (touches ${m.touches.join(", ")})`);
    for (const e of r.extras.slice(0, 10)) console.log(`   invented p${e.page} ${String(e.length).padStart(5)} px ${e.kind} ${e.id ?? ""} at ${e.bbox.join(",")}`);
  }
}
