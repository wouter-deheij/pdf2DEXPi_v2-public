/**
 * Rebuild everything downstream of the drawing model — tables + databases, DEXPI (+ SVG preview),
 * answer + report — for existing projects from their drawing.model.json. No model calls.
 * Usage: npm run redexpi -- [project ...]   (no arguments = all projects)
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import { overlaySummary, writeOverlay } from "./pipeline/overlay.ts";
import { tabulate } from "./pipeline/tabulate.ts";
import { dexpi } from "./pipeline/dexpi.ts";
import { report } from "./pipeline/report.ts";
import { enrichInstruments } from "./pipeline/digitize.ts";
import { linkLooseByLoop } from "./pipeline/instlinks.ts";
import { describeIsa } from "./pipeline/merge.ts";
import { applyGeometry, closeOpenEnds, computeNets, fitBubbles, fitEquipment, joinDrawnPipes, labelLeaders, linkByNets, nozzleLabels, placeOrphans, tagsFromText, loadVector, mergeWordTokens } from "./pipeline/vectorlayer.ts";
import { dropEdgeGhosts, expandTokens, setOcrOpenPoints, unlistedTags, type Token } from "./pipeline/ocr.ts";

/** Old tag split (letters up to the first digit), to recognise values derived from it. */
const oldLetters = (tag: string | null) => tag?.replace(/\s+/g, "").match(/^([A-Za-z]+)/)?.[1] ?? "";

const args = process.argv.slice(2);
const projects = args.length
  ? args
  : fs.readdirSync(OUTPUT_DIR).filter((d) => fs.existsSync(path.join(OUTPUT_DIR, d, "drawing.model.json")));
let failed = 0;
for (const p of projects) {
  const dir = path.join(OUTPUT_DIR, p);
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [] });
  ctx.persist = () => {};
  ctx.bag.model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  // re-derive loop / type / description of instruments with the current tag rules
  const model = ctx.bag.model as DrawingModel;
  for (const it of model.items) {
    if (it.category !== "instrument") continue;
    const old = oldLetters(it.tag);
    if (it.type === old) it.type = "";
    if (it.description && it.description === describeIsa(old)) it.description = null;
  }
  const before = new Map(model.items.map((i) => [i.id, i.tag]));
  enrichInstruments(model.items);
  const changed = model.items.filter((i) => before.get(i.id) !== i.tag);
  if (changed.length) console.log(`${p}: tags corrected: ${changed.map((i) => `${before.get(i.id)} → ${i.tag}`).join(", ")}`);
  // OCR open points with the current matching rules (saved tokens, no new OCR)
  const tokFile = path.join(dir, "work", "ocr_tokens.json");
  if (fs.existsSync(tokFile)) {
    const pages = model.pages.map((pg) => ({ n: pg.n, W: pg.px[0], H: pg.px[1] }));
    const tokens = mergeWordTokens(dropEdgeGhosts(JSON.parse(fs.readFileSync(tokFile, "utf8")) as Token[], pages), loadVector(ctx, pages)).tokens;
    const unlisted = unlistedTags(model, expandTokens(tokens));
    setOcrOpenPoints(model, unlisted);
    console.log(`${p}: ${unlisted.length} unlisted printed tags: ${unlisted.map((t) => t.norm).join(", ") || "—"}`);
  }
  // bubbles without any link: join their loop (inferred, basis "loop")
  const loose = linkLooseByLoop(model);
  if (loose.length) {
    console.log(`${p}: linked by loop number: ${loose.join(", ")}`);
    model.comments.push(`instrument links inferred from the loop number (no drawn line): ${loose.join(", ")}`);
  }
  // vector layer: drawn signal lines and exact pipe routes from the PDF (CAD PDFs only)
  {
    const pages = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
    const outlined = fitEquipment(ctx, model, pages);
    if (outlined.length) console.log(`${p}: equipment to drawn outline: ${outlined.join("; ")}`);
    const moved = labelLeaders(ctx, model, pages);
    if (moved.length) console.log(`${p}: tag labels to their symbol: ${moved.join("; ")}`);
    const tagged = tagsFromText(ctx, model, pages);
    if (tagged.length) console.log(`${p}: printed letter code for untagged instruments: ${tagged.join(", ")}`);
    const fitted = fitBubbles(ctx, model, pages);
    if (fitted) console.log(`${p}: ${fitted} instrument boxes set to their drawn bubble`);
    // the drawn lines settle what the runs leave out, as in a run's connect stage (same as the A/B check)
    const drawn = computeNets(ctx, model, pages);
    const fixes = drawn.size ? [...closeOpenEnds(model, drawn), ...placeOrphans(model, drawn), ...joinDrawnPipes(model, drawn), ...linkByNets(model, drawn)] : [];
    if (fixes.length) console.log(`${p}: from the drawn lines: ${fixes.join("; ")}`);
    const nets = computeNets(ctx, model, pages);
    const g = applyGeometry(model, nets);
    const named = nozzleLabels(ctx, model, pages, nets);
    if (named.length) console.log(`${p}: nozzle names from the drawing: ${named.join(", ")}`);
    if (g.signalLines || g.routes) console.log(`${p}: ${g.signalLines} drawn signal lines (${g.carried} links carried), ${g.routes} exact pipe routes, ${g.taps} tap points`);
  }
  fs.writeFileSync(path.join(dir, "drawing.model.json"), JSON.stringify(model, null, 2));
  ctx.bag.profile = JSON.parse(fs.readFileSync(path.join(dir, "drawing.profile.json"), "utf8"));
  const answerFile = path.join(dir, "drawing.answer.json");
  ctx.bag.score = run.score ?? (fs.existsSync(answerFile) ? JSON.parse(fs.readFileSync(answerFile, "utf8")).confidence : undefined) ?? 0;
  try {
    tabulate(ctx);
    dexpi(ctx);
    report(ctx);
    const o = await writeOverlay(ctx, model);
    if (o?.vector) console.log(`${p}: overlay ${overlaySummary(o)}`);
  } catch (e) {
    failed++;
    console.log(`${p}: FAILED ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
