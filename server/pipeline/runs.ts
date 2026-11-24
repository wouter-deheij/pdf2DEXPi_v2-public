import fs from "node:fs";
import path from "node:path";
import type { Answer, DrawingModel, Item, RunState } from "../types.ts";

/**
 * Every run of a project is kept in full under output/<project>/runs/run-<n>/ (model, DEXPI, tables,
 * databases, overlay, report, log, pages, work files; not the tiles sent to the model). The project
 * folder itself holds the active run, so every tool that reads output/<project>/ keeps working.
 * Switching runs first writes the active one back to its own folder: rebuilds made since are kept.
 */
export const RUNS_DIR = "runs";
const NOT_KEPT = new Set([RUNS_DIR, "tiles"]);

const readJSON = <T,>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

export interface RunInfo {
  n: number;
  active: boolean;
  status: RunState["status"] | "unknown";
  started_at?: string;
  finished_at?: string;
  cost_usd?: number;
  rerun?: RunState["rerun"];
  counts?: { equipment: number; instruments: number; valves: number; lines: number };
  open_points?: number;
  confidence?: number;
  overlay?: { precision: number | null; pipeRecall: number | null; signalRecall: number | null } | null;
}

function slots(dir: string): number[] {
  const r = path.join(dir, RUNS_DIR);
  if (!fs.existsSync(r)) return [];
  return fs
    .readdirSync(r)
    .map((d) => /^run-(\d+)$/.exec(d)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}
export const nextRunNo = (dir: string) => Math.max(0, ...slots(dir)) + 1;

function info(d: string, n: number, active: boolean): RunInfo {
  const run = readJSON<RunState>(path.join(d, "run.json"));
  const answer = readJSON<Answer>(path.join(d, "drawing.answer.json"));
  const ov = readJSON<{ vector: boolean; precision: number | null; pipeRecall: number | null; signalRecall: number | null }>(path.join(d, "overlay.json"));
  return {
    n,
    active,
    status: run?.status ?? "unknown",
    started_at: run?.started_at,
    finished_at: run?.finished_at,
    cost_usd: run?.usage?.cost_usd,
    rerun: run?.rerun,
    counts: answer ? { equipment: answer.equipment_count, instruments: answer.instrument_count, valves: answer.valve_count, lines: answer.line_count } : undefined,
    open_points: answer?.unresolved.length,
    confidence: answer?.confidence,
    overlay: ov?.vector ? { precision: ov.precision, pipeRecall: ov.pipeRecall, signalRecall: ov.signalRecall } : null,
  };
}

/** All runs of a project, oldest first; the active one is read from the project folder (it may have been rebuilt since). */
export function listRuns(dir: string): RunInfo[] {
  const active = readJSON<RunState>(path.join(dir, "run.json"))?.run_no;
  const out = slots(dir).map((n) => (n === active ? info(dir, n, true) : info(path.join(dir, RUNS_DIR, `run-${n}`), n, false)));
  // a project from before runs were kept: its only run is the active one
  if (!out.length && fs.existsSync(path.join(dir, "run.json"))) out.push(info(dir, 1, true));
  return out;
}

const copyRun = (from: string, to: string) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from)) if (!NOT_KEPT.has(e)) fs.cpSync(path.join(from, e), path.join(to, e), { recursive: true });
};

/**
 * Write the active run (the project folder) to its own runs/run-<n>/ folder; a project from before runs
 * were kept gets its number here. Returns that number, or null when there is no finished run.
 */
export function archiveActive(dir: string): number | null {
  const file = path.join(dir, "run.json");
  const run = readJSON<RunState>(file);
  if (!run || run.status === "running") return null;
  if (!run.run_no) {
    run.run_no = nextRunNo(dir);
    fs.writeFileSync(file, JSON.stringify(run, null, 2));
  }
  const to = path.join(dir, RUNS_DIR, `run-${run.run_no}`);
  fs.rmSync(to, { recursive: true, force: true });
  copyRun(dir, to);
  return run.run_no;
}

/** Make run n the active one (after keeping the active one). */
export function activateRun(dir: string, n: number) {
  const from = path.join(dir, RUNS_DIR, `run-${n}`);
  if (!fs.existsSync(path.join(from, "run.json"))) throw new Error(`run ${n} does not exist`);
  if (readJSON<RunState>(path.join(dir, "run.json"))?.run_no === n) return;
  archiveActive(dir);
  clearActive(dir);
  copyRun(from, dir);
}

/** Empty the project folder for a new run; the kept runs stay. */
export function clearActive(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) if (e !== RUNS_DIR) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
}

// ---------------------------------------------------------------- guidance for a second reading

const MAX_POINTS = 40, MAX_OVERLAY = 15, MIN_PX = 150;

/**
 * What a new reading of the drawing gets from the active run: the engineer's notes, the open points,
 * and where its drawing does not lie on the PDF (drawn lines it left out, lines it has where nothing is
 * drawn), in tags rather than pixels. These are places to look, not answers.
 */
export function rerunGuidance(dir: string, notes: string): { text: string; points: number; overlay: number } {
  const model = readJSON<DrawingModel>(path.join(dir, "drawing.model.json"));
  const answer = readJSON<Answer>(path.join(dir, "drawing.answer.json"));
  const ov = readJSON<{ vector: boolean; misses: { length: number; touches: string[] }[]; extras: { length: number; kind: string; id: string | null }[] }>(path.join(dir, "overlay.json"));
  const items = new Map((model?.items ?? []).map((i) => [i.id, i]));
  const name = (id: string) => {
    const it: Item | undefined = items.get(id);
    if (!it) return id;
    return it.tag ? `${it.tag} (${it.type || it.category})` : `untagged ${it.type || it.category}${it.description ? ` "${it.description}"` : ""}`;
  };
  const lines = new Map((model?.lines ?? []).map((l) => [l.id, l]));
  const endName = (e: { kind: string; ref: string | null }) => (e.ref ? (items.has(e.ref) ? name(e.ref) : lines.has(e.ref) ? `a branch on ${lines.get(e.ref)!.line_id ?? e.ref}` : e.ref) : e.kind === "open" ? "an open end" : e.kind);

  const points = (answer?.unresolved ?? model?.ambiguities ?? []).slice(0, MAX_POINTS).map((a) => `- ${a.tag}: ${a.issue}`);

  const missed: string[] = [];
  const invented: string[] = [];
  if (ov?.vector) {
    const seen = new Set<string>();
    for (const m of ov.misses) {
      if (m.length < MIN_PX || !m.touches.length || missed.length >= MAX_OVERLAY) continue;
      const key = [...m.touches].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      missed.push(m.touches.length === 1 ? `- a drawn line leaving ${name(m.touches[0])}` : `- a drawn line between ${m.touches.map(name).join(", ")}`);
    }
    for (const e of ov.extras) {
      if (e.length < MIN_PX || !e.id || invented.length >= MAX_OVERLAY) continue;
      const base = e.id.split(".")[0];
      if (seen.has(`x:${base}:${e.kind}`)) continue;
      seen.add(`x:${base}:${e.kind}`);
      const l = lines.get(base);
      if (e.kind === "pipe" && l) invented.push(`- pipe ${l.line_id ?? l.id}${l.service ? ` (${l.service})` : ""} from ${endName(l.from)} to ${endName(l.to)}: part of its route is not on the drawing; check its end points and the order of its components`);
      else if (e.kind === "signal" && items.has(base)) invented.push(`- a signal from ${name(base)}: no line drawn where it was placed; check what it connects to`);
      else if (e.kind === "instrument" && items.has(base)) invented.push(`- ${name(base)}: its connection to the process is not drawn where it was placed; check where it taps the pipe or vessel`);
    }
  }

  const parts: string[] = [];
  const n = notes.trim();
  if (n) parts.push(`### Notes from the engineer who checked it (most important)\n${n}`);
  if (points.length) parts.push(`### Open points of the earlier reading\n${points.join("\n")}`);
  if (missed.length) parts.push(`### Lines drawn on the sheet that the earlier reading did not use\nEach may be a pipe or a signal line it missed, or something that is neither (a shaft, a frame, a leader): check what it is before adding anything.\n${missed.join("\n")}`);
  if (invented.length) parts.push(`### Parts of the earlier reading where nothing is drawn\n${invented.join("\n")}`);
  if (!parts.length) return { text: "", points: 0, overlay: 0 };
  const text = `This drawing has been read before. Checking that earlier reading against the drawing gave the points below. Look at these places with extra care. They are hints about where the earlier reading may be wrong or incomplete, not facts: report only what you see on the drawing, and where a point turns out to be right as it was, keep it.

${parts.join("\n\n")}`;
  return { text, points: points.length, overlay: missed.length + invented.length };
}
