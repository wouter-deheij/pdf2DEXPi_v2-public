// Dev helper: re-run the merge on a project's saved tile detections (no model calls).
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import { mergeCandidates, type Candidate } from "./pipeline/merge.ts";
const p = process.argv[2];
const dir = path.join(OUTPUT_DIR, p);
const cands = JSON.parse(fs.readFileSync(path.join(dir, "work/candidates.json"), "utf8")) as Candidate[];
const prof = JSON.parse(fs.readFileSync(path.join(dir, "drawing.profile.json"), "utf8"));
const items = mergeCandidates(cands, prof.pages_px);
fs.writeFileSync(path.join(dir, "work/remerge.json"), JSON.stringify(items, null, 2));
console.log(items.length, "items");

// optional: OCR anchor on the re-merged items (uses saved tiles)
if (process.argv.includes("--ocr")) {
  const { runOcr, anchorItems } = await import("./pipeline/ocr.ts");
  const { RunContext } = await import("./pipeline/context.ts");
  const tiles = JSON.parse(fs.readFileSync(path.join(dir, "tiles/index.json"), "utf8"));
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [] });
  ctx.persist = () => {};
  const tokens = await runOcr(ctx, tiles);
  const model = { pages: prof.pages_px.map((px: [number, number], k: number) => ({ n: k + 1, px, image: "" })), items } as any;
  const a = anchorItems(model, tokens);
  fs.writeFileSync(path.join(dir, "work/remerge.json"), JSON.stringify(items, null, 2));
  console.log(`ocr tokens ${tokens.length}, matched ${a.matched}, moved ${a.moved}, unlisted: ${a.unlisted.map((t: any) => t.text).join(", ")}`);
}

// optional: whole-sheet overview for large equipment (one model call per page), then reconcile
if (process.argv.includes("--major")) {
  const { readMajorEquipment, reconcileMajor } = await import("./pipeline/major.ts");
  const { RunContext } = await import("./pipeline/context.ts");
  const { systemPrompt } = await import("./pipeline/prompts.ts");
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [], usage: { ...run.usage, calls: 0, cost_usd: 0 } });
  ctx.persist = () => {};
  const pages = prof.pages_px.map((px: [number, number], k: number) => ({ n: k + 1, file: path.join(dir, `pages/page-${k + 1}.png`), rel: "", W: px[0], H: px[1] }));
  const major = await readMajorEquipment(ctx, pages, systemPrompt(run.settings, prof.standard ?? "auto"));
  console.log(major.map((m) => `${m.tag ?? "—"} ${m.type} [${m.box.join(",")}] ${m.confidence}`).join("\n"));
  console.log(reconcileMajor(items, major));
  console.log("equipment:", items.filter((i) => i.category === "equipment").map((i) => `${i.id}(${i.type})`).join(", "));
  console.log(`cost $${ctx.state.usage.cost_usd.toFixed(3)}`);
  fs.writeFileSync(path.join(dir, "work/remerge.json"), JSON.stringify(items, null, 2));
}
