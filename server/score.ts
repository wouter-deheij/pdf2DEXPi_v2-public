/**
 * Answer keys and scores.
 *   npm run score                      score every project that has a key
 *   npm run score -- <project> [-v]    one project; -v lists what was missed / extra / read wrongly
 *   npm run score -- --draft <project> make a draft key from the project's current model (never overwrites)
 *   npm run score -- --counts [project] only the counted totals (key.counts); exit code 1 when one is off
 *                                      by more than 10 % — a quick regression check after a code change
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { KEYS_DIR, checkCounts, draftKey, readKey, scoreModel, writeKey } from "./pipeline/answerkey.ts";

const args = process.argv.slice(2);
const verbose = args.includes("-v");
const names = args.filter((a) => !a.startsWith("-"));
const model = (p: string) => JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, p, "drawing.model.json"), "utf8")) as DrawingModel;

if (args.includes("--draft")) {
  for (const p of names) {
    if (readKey(p)) {
      console.log(`${p}: key exists already — not overwritten`);
      continue;
    }
    const run = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, p, "run.json"), "utf8"));
    const k = draftKey(p, model(p), run.source ?? null);
    writeKey(k);
    console.log(`${p}: draft key with ${k.items.length} items and ${k.links.length} links → reference/keys/${p}.key.json`);
  }
  process.exit(0);
}

const projects = names.length ? names : fs.existsSync(KEYS_DIR) ? fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith(".key.json")).map((f) => f.replace(/\.key\.json$/, "")) : [];
if (args.includes("--counts")) {
  const all = names.length ? names : fs.existsSync(KEYS_DIR) ? fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith(".key.json")).map((f) => f.replace(/\.key\.json$/, "")) : [];
  let off = 0;
  for (const p of all) {
    const key = readKey(p);
    if (!key?.counts) {
      if (names.length) console.log(`${p}: no counts in the key`);
      continue;
    }
    const c = checkCounts(key.counts, model(p));
    if (!c.ok) off++;
    console.log(`${c.ok ? "✓" : "✗"} ${p}: ${c.summary}`);
    if (verbose) for (const r of c.rows) console.log(`    ${r.status === "ok" ? " " : r.status === "near" ? "~" : "✗"} ${r.what.padEnd(16)} ${String(r.found).padStart(4)} / ${r.expected}`);
  }
  process.exit(off ? 1 : 0);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
for (const p of projects) {
  const key = readKey(p);
  if (!key) {
    console.log(`${p}: no key (make one with npm run score -- --draft ${p})`);
    continue;
  }
  const s = scoreModel(key, model(p));
  console.log(`\n${p}   (key ${pct(s.reviewed)} checked${s.reviewed < 1 ? " — scores are provisional" : ""})`);
  console.log(`  items   P ${pct(s.items.precision)}  R ${pct(s.items.recall)}  F1 ${pct(s.items.f1)}   (${s.items.tp} found, ${s.items.fn} missed, ${s.items.fp} extra)`);
  for (const [c, v] of Object.entries(s.items.by_category)) console.log(`    ${c.padEnd(17)} P ${pct(v.precision)}  R ${pct(v.recall)}   (${v.tp}/${v.tp + v.fn})`);
  const a = s.attributes;
  console.log(`  read right (of ${a.matched} found): category ${pct(a.category / Math.max(1, a.matched))}, tag ${pct(a.tag / Math.max(1, a.matched))}, DEXPI class ${pct(a.dexpi_class / Math.max(1, a.matched))}`);
  console.log(`  links   P ${pct(s.links.precision)}  R ${pct(s.links.recall)}  F1 ${pct(s.links.f1)}   (${s.links.tp} right, ${s.links.fn} missed, ${s.links.fp} extra)`);
  if (key.counts) console.log(`  counts  ${checkCounts(key.counts, model(p)).summary}   (${key.counts.source}, ${key.counts.date})`);
  if (verbose) {
    if (s.missed.length) console.log(`  missed: ${s.missed.join("; ")}`);
    if (s.extra.length) console.log(`  extra: ${s.extra.join("; ")}`);
    if (s.wrong.length) console.log(`  read wrongly:\n    ${s.wrong.join("\n    ")}`);
  }
}
