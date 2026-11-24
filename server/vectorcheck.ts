/**
 * Vector layer on existing projects, without model calls.
 *  npm run vectorcheck -- [project ...]            report: nets, agreement with the traced runs,
 *                                                  open ends and instrument links the geometry settles
 *  npm run vectorcheck -- --apply [project ...]    also write those fixes to drawing.model.json
 *                                                  (then: npm run redexpi)
 * Writes work/nets_p<n>.json and work/nets_p<n>.png (drawn nets over the sheet) per project.
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import type { PageImage } from "./pipeline/locate.ts";
import { closeOpenEnds, computeNets, drawNets, fitBubbles, fitEquipment, fitSymbols, labelLeaders, joinDrawnPipes, tagsFromText, linkByNets, loadVector, netAgreement, placeOrphans, vectorSummary } from "./pipeline/vectorlayer.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verbose = args.includes("-v");
const names = args.filter((a) => !a.startsWith("-"));
const projects = names.length ? names : fs.readdirSync(OUTPUT_DIR).filter((d) => fs.existsSync(path.join(OUTPUT_DIR, d, "drawing.model.json")));

for (const p of projects) {
  const dir = path.join(OUTPUT_DIR, p);
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [] });
  ctx.persist = () => {};
  const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  const pages: PageImage[] = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
  const v = loadVector(ctx, pages);
  const outlined = fitEquipment(ctx, model, pages);
  if (outlined.length) console.log(`${p}: equipment to drawn outline: ${outlined.join("; ")}`);
  const moved = labelLeaders(ctx, model, pages);
  if (moved.length) console.log(`${p}: tag labels to their symbol: ${moved.join("; ")}`);
  const tagged = tagsFromText(ctx, model, pages);
  if (tagged.length) console.log(`${p}: printed letter code for untagged instruments: ${tagged.join(", ")}`);
  const fitted = fitBubbles(ctx, model, pages);
  const symbols = fitSymbols(ctx, model, pages);
  if (symbols.length) console.log(`${p}: valve boxes from their printed tag to the drawn symbol: ${symbols.join("; ")}`);
  const nets = computeNets(ctx, model, pages);
  if (!nets.size) {
    console.log(`${p}: ${vectorSummary(v)} — nothing to do`);
    continue;
  }
  for (const pg of pages) {
    const n = nets.get(pg.n);
    if (n) await drawNets(pg.file, ctx.path("work", `nets_p${pg.n}.png`), pg.W, pg.H, n, model.items.filter((i) => i.page === pg.n));
  }
  const before = netAgreement(model, nets);
  const openBefore = model.lines.reduce((a, l) => a + +(l.from.kind === "open") + +(l.to.kind === "open"), 0);
  const unlinkedBefore = model.items.filter((i) => i.category === "instrument" && !model.signals.some((s) => s.instrument === i.id)).length;
  const orphansBefore = model.items.filter((i) => (i.category === "valve" || i.category === "piping_component") && !model.lines.some((l) => l.components.includes(i.id))).length;
  const ends = closeOpenEnds(model, nets);
  const strays = placeOrphans(model, nets);
  const joined = joinDrawnPipes(model, nets);
  if (joined.length) console.log(`${p}: drawn pipes the runs left out: ${joined.join("; ")}`);
  const links = linkByNets(model, nets);
  const after = netAgreement(model, nets);
  const all = [...nets.values()].flat();
  console.log(
    `${p}: ${vectorSummary(v)}\n  nets ${all.filter((n) => !n.dash).length} solid / ${all.filter((n) => n.dash).length} dashed; runs agree with the drawn lines ${before.ok}/${before.pairs} (${before.share})` +
      `\n  open run ends ${openBefore} → ${openBefore - ends.length}: ${ends.join("; ") || "—"}` +
      `\n  components on no run ${orphansBefore} → ${orphansBefore - strays.reduce((a, s) => a + s.split(" + ").length, 0)}: ${strays.join("; ") || "—"}` +
      `\n  instruments without link ${unlinkedBefore} → ${unlinkedBefore - links.length}: ${links.join("; ") || "—"}`,
  );
  if (verbose && before.doubt.length) console.log(`  not confirmed by the drawn lines:\n    ${before.doubt.join("\n    ")}`);
  if (fitted) console.log(`  ${fitted} instrument boxes set to their drawn bubble`);
  if (apply && (ends.length || links.length || strays.length || fitted || outlined.length || tagged.length || joined.length)) {
    model.comments.push(`vector layer: ${ends.length} run ends closed, ${strays.length} unplaced components placed, ${links.length} instruments linked from the drawn lines`);
    fs.writeFileSync(path.join(dir, "drawing.model.json"), JSON.stringify(model, null, 2));
    console.log(`  written (agreement now ${after.ok}/${after.pairs})`);
  }
}
