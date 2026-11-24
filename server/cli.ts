// Headless run:  npm run pipeline -- input/drawing.pdf [--depth fast|verified|exhaustive] [--standard auto|iso|…] [--effort low|medium|high] [--project name]
import fs from "node:fs";
import path from "node:path";
import { INPUT_DIR } from "./config.ts";
import { DEFAULT_SETTINGS, type RunSettings } from "./types.ts";
import { startRun } from "./pipeline/run.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!positional.length) {
  console.error("usage: npm run pipeline -- <drawing.pdf> [--depth verified] [--standard auto] [--effort medium] [--project name]");
  process.exit(1);
}
const settings: RunSettings = {
  ...DEFAULT_SETTINGS,
  ...(opt("depth") ? { depth: opt("depth") as RunSettings["depth"] } : {}),
  ...(opt("standard") ? { standard: opt("standard") as RunSettings["standard"] } : {}),
  ...(opt("effort") ? { effort: opt("effort") as RunSettings["effort"] } : {}),
};

for (const p of positional) {
  const file = fs.existsSync(p) ? p : path.join(INPUT_DIR, p);
  const { done } = startRun(path.resolve(file), settings, opt("project"));
  const state = await done;
  console.log(`\n${state.project}: ${state.status}${state.error ? ` — ${state.error}` : ""} (≈ $${state.usage.cost_usd.toFixed(2)})`);
  if (state.status !== "done") process.exitCode = 1;
}
