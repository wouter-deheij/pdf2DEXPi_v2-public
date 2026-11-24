/**
 * Give the uncertain audit findings of existing projects their zoomed second look
 * (one small model call per open finding), apply the outcome to drawing.model.json, then
 * rebuild tables, DEXPI and report with `npm run redexpi`.
 * Usage: npm run recheck -- [project ...]   (no arguments = all projects)
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import { systemPrompt } from "./pipeline/prompts.ts";
import { applyFinding, auditBlocks, settle, type Finding } from "./pipeline/verify.ts";
import { ambiguityOf, recheckFindings, type Deferred } from "./pipeline/recheck.ts";

const args = process.argv.slice(2);
const projects = args.length ? args : fs.readdirSync(OUTPUT_DIR).filter((d) => fs.existsSync(path.join(OUTPUT_DIR, d, "drawing.model.json")));
for (const p of projects) {
  const dir = path.join(OUTPUT_DIR, p);
  const runFile = path.join(dir, "run.json");
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  const ctx = new RunContext(dir, run.settings, { ...run, log: [], usage: { ...run.usage } });
  ctx.persist = () => {};
  const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  const costBefore = ctx.state.usage.cost_usd;

  // the uncertain findings that are still open points
  const open = new Set(model.ambiguities.map((a) => a.issue));
  const list: Deferred[] = [];
  for (const file of fs.readdirSync(path.join(dir, "work")).filter((f) => /^audit_r\d+_.+\.json$/.test(f))) {
    const id = file.replace(/^audit_r\d+_|\.json$/g, "");
    const pageNo = Number(id.match(/^ap(\d+)_/)?.[1] ?? 1);
    const [W, H] = model.pages.find((pg) => pg.n === pageNo)!.px;
    const r = auditBlocks({ n: pageNo, W, H }).find((b) => b.id === id);
    if (!r) continue;
    const reply = JSON.parse(fs.readFileSync(path.join(dir, "work", file), "utf8")) as { findings: Finding[] };
    for (const f of reply.findings) if (f.confidence < 0.6 && open.has(ambiguityOf({ f, r }).issue)) list.push({ f, r });
  }
  if (!list.length) {
    console.log(`${p}: no uncertain audit findings open`);
    continue;
  }
  const rc = await recheckFindings(ctx, model, list, systemPrompt(run.settings, model.standard));
  const removed = new Set<string>();
  for (const c of rc.confirmed) applyFinding(model, c.f, c.r, "recheck", "audit, confirmed on a zoomed look", removed);
  settle(model, removed);
  // replace the old open points of these findings by what is still open
  const handled = new Set(list.map((d) => ambiguityOf(d).issue));
  model.ambiguities = [...model.ambiguities.filter((a) => !handled.has(a.issue)), ...rc.unsure.map(ambiguityOf)];
  if (rc.rejected.length) model.comments.push(`recheck: ${rc.rejected.length} uncertain audit findings rejected on a zoomed look`);
  fs.writeFileSync(path.join(dir, "drawing.model.json"), JSON.stringify(model, null, 2));
  fs.writeFileSync(path.join(dir, "work", "recheck.json"), JSON.stringify(rc, null, 2));

  const cost = ctx.state.usage.cost_usd - costBefore;
  run.usage = ctx.state.usage;
  run.log = [...(run.log ?? []), ...ctx.state.log];
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  console.log(`${p}: ${list.length} uncertain → ${rc.confirmed.length} confirmed, ${rc.rejected.length} rejected, ${rc.unsure.length} still open; ${removed.size} items removed; cost $${cost.toFixed(2)}`);
  for (const c of rc.confirmed) console.log(`   ✓ ${c.f.kind} ${c.f.item_id ?? c.f.proposed?.tag ?? ""}: ${c.f.issue.split(" — zoom: ")[1] ?? ""}`);
  for (const c of rc.rejected) console.log(`   ✗ ${c.f.kind} ${c.f.item_id ?? ""}: ${c.f.issue.slice(0, 90)}`);
}
