// A/B check: does the code in the working tree score better or worse than a git commit, on every
// stored project? Both sides run on the same stored runs (output/), in memory; nothing is written.
//
//   npm run ab                      working tree vs HEAD, all projects
//   npm run ab -- main~3            vs another commit, branch or tag
//   npm run ab -- HEAD R9 PID024    only projects whose name starts with R9 or PID024
//
// Exit code 1 when any project gets worse by more than the rounding slack (0.05 percentage point
// on fit = (on the PDF + pipe followed) / 2, or on signal recall), or a project fails to run.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Measure } from "./ab/measure.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLACK = 0.0005;
const args = process.argv.slice(2);
const ref = args[0] && !args[0].startsWith("-") ? args.shift()! : "HEAD";
const only = args;

const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const sha = git("rev-parse", "--short", `${ref}^{commit}`);
const dirty = git("status", "--porcelain", "--", "server").length > 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pid-ab-"));
const base = path.join(tmp, "base");
git("worktree", "add", "--detach", "--quiet", base, sha);
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(base, "node_modules"), "dir");

const measure = (code: string, out: string) =>
  new Promise<Record<string, Measure>>((resolve, reject) => {
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const p = spawn(tsx, [path.join(ROOT, "server", "ab", "measure.ts"), code, ROOT, out, ...only], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    p.on("exit", (c) => (c === 0 ? resolve(JSON.parse(fs.readFileSync(out, "utf8"))) : reject(new Error(`measure (${code}) exited with ${c}`))));
  });

let failed = false;
try {
  console.log(`A/B: working tree${dirty ? " (uncommitted changes)" : ""} vs ${ref} (${sha})${only.length ? `, projects ${only.join(" ")}` : ""} …`);
  const [A, B] = await Promise.all([measure(base, path.join(tmp, "a.json")), measure(ROOT, path.join(tmp, "b.json"))]);
  const pct = (x: number | null | undefined) => (x == null ? "—" : (100 * x).toFixed(1));
  const fit = (m?: Measure) => (m && m.precision != null && m.pipeRecall != null ? (m.precision + m.pipeRecall) / 2 : null);
  const rows: Record<string, unknown>[] = [];
  let better = 0, worse = 0;
  for (const p of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    const a = A[p], b = B[p];
    const fa = fit(a), fb = fit(b);
    const dfit = fa != null && fb != null ? fb - fa : null;
    const dsig = a?.signalRecall != null && b?.signalRecall != null ? b.signalRecall - a.signalRecall : 0;
    const bad = !!b?.error || !b || (dfit != null && dfit < -SLACK) || dsig < -SLACK;
    const good = !bad && ((dfit ?? 0) > SLACK || dsig > SLACK);
    if (bad) worse++;
    if (good) better++;
    rows.push({
      project: p.slice(0, 26),
      "op de PDF": `${pct(a?.precision)} → ${pct(b?.precision)}`,
      "leiding gevolgd": `${pct(a?.pipeRecall)} → ${pct(b?.pipeRecall)}`,
      signaal: `${pct(a?.signalRecall)} → ${pct(b?.signalRecall)}`,
      "Δfit": dfit == null ? "—" : (100 * dfit).toFixed(2),
      routes: `${a?.routed ?? "—"}/${a?.routes ?? "—"} → ${b?.routed ?? "—"}/${b?.routes ?? "—"}`,
      "no-path": `${a?.noPath ?? "—"} → ${b?.noPath ?? "—"}`,
      "": bad ? "✗ slechter" : good ? "✓ beter" : "",
    });
    if (b?.error) console.error(`${p}: ${b.error}`);
    if (a?.error) console.error(`${p} (basis ${sha}): ${a.error}`);
  }
  console.table(rows);
  failed = worse > 0;
  console.log(failed ? `✗ ${worse} project(en) slechter dan ${ref}.` : `✓ geen project slechter dan ${ref}; ${better} beter.`);
} finally {
  git("worktree", "remove", "--force", base);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
