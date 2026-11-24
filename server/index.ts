import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import { INPUT_DIR, MODEL, OUTPUT_DIR, PORT, ROOT } from "./config.ts";
import { DEFAULT_SETTINGS, type DrawingModel, type ProjectSummary, type RunSettings, type RunState } from "./types.ts";
import { draftKey, readKey, scoreModel, writeKey, type AnswerKey } from "./pipeline/answerkey.ts";
import { activeRuns, projectName, startCorrection, startRun } from "./pipeline/run.ts";
import { correctionIssues } from "./pipeline/correct.ts";
import { RUNS_DIR, activateRun, listRuns, rerunGuidance } from "./pipeline/runs.ts";
import { catalogFromProject } from "./pipeline/tabulate.ts";

fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "20mb" }));

const readJSON = <T,>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const projectDir = (p: string) => {
  const dir = path.join(OUTPUT_DIR, path.basename(p));
  if (!dir.startsWith(OUTPUT_DIR)) throw new Error("bad project");
  return dir;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, api_key: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) });
});

// ---- input drawings ----
app.get("/api/inputs", (_req, res) => {
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => /\.(pdf|png|jpe?g|tiff?)$/i.test(f))
    .map((f) => ({ file: f, bytes: fs.statSync(path.join(INPUT_DIR, f)).size, project: projectName(f) }));
  res.json(files);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: INPUT_DIR,
    filename: (_req, file, cb) => cb(null, path.basename(file.originalname).replace(/[^\w.\-&() ]+/g, "_")),
  }),
  fileFilter: (_req, file, cb) => cb(null, /\.(pdf|png|jpe?g|tiff?)$/i.test(file.originalname)),
  limits: { fileSize: 200 * 1024 * 1024 },
});
app.post("/api/upload", upload.single("drawing"), (req, res) => {
  if (!req.file) return void res.status(400).json({ error: "Only PDF/PNG/JPG/TIFF files are accepted" });
  res.json({ file: req.file.filename, project: projectName(req.file.filename) });
});

// ---- projects ----
app.get("/api/projects", (_req, res) => {
  const list: ProjectSummary[] = fs
    .readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(OUTPUT_DIR, d.name);
      const run = activeRuns.get(d.name)?.state ?? readJSON<RunState>(path.join(dir, "run.json"));
      const summary: ProjectSummary = {
        project: d.name,
        source: run?.source ?? "",
        status: run?.status ?? "unknown",
        started_at: run?.started_at,
        usage: run?.usage,
        answer: readJSON(path.join(dir, "drawing.answer.json")),
      };
      return summary;
    })
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  res.json(list);
});

/** The overlay score with only the largest misses and invented stretches (the full list can be long). */
function overlayBrief(o: any) {
  if (!o) return null;
  return { ...o, misses: (o.misses ?? []).slice(0, 15), extras: (o.extras ?? []).slice(0, 15) };
}

app.get("/api/projects/:p", (req, res) => {
  const dir = projectDir(req.params.p);
  if (!fs.existsSync(dir)) return void res.status(404).json({ error: "not found" });
  res.json({
    run: activeRuns.get(req.params.p)?.state ?? readJSON(path.join(dir, "run.json")),
    profile: readJSON(path.join(dir, "drawing.profile.json")),
    answer: readJSON(path.join(dir, "drawing.answer.json")),
    model: readJSON(path.join(dir, "drawing.model.json")) ?? readJSON(path.join(dir, "drawing.model.first_pass.json")),
    dexpi: readJSON(path.join(dir, "dexpi_report.json")),
    overlay: overlayBrief(readJSON(path.join(dir, "overlay.json"))),
    files: listFiles(dir),
    runs: listRuns(dir),
  });
});

// ---- runs of a project: every run is kept; one is active ----
/** What a re-run would get as hints (open points, overlay, notes), before it is started. */
app.post("/api/projects/:p/rerun/preview", (req, res) => {
  const dir = projectDir(req.params.p);
  if (!fs.existsSync(path.join(dir, "run.json"))) return void res.status(404).json({ error: "no run to start from" });
  res.json(rerunGuidance(dir, String(req.body?.notes ?? "")));
});
/** A new reading of the same drawing, with what checking the active run found as hints. */
app.post("/api/projects/:p/rerun", (req, res) => {
  const p = path.basename(req.params.p);
  const dir = projectDir(p);
  const prev = readJSON<RunState>(path.join(dir, "run.json"));
  if (!prev) return void res.status(404).json({ error: "no run to start from" });
  const src = path.join(INPUT_DIR, path.basename(prev.source));
  if (!fs.existsSync(src)) return void res.status(400).json({ error: `Drawing not found in input/: ${prev.source}` });
  const notes = String(req.body?.notes ?? "");
  const g = rerunGuidance(dir, notes);
  const { guidance: _old, ...settings } = prev.settings;
  try {
    startRun(src, { ...DEFAULT_SETTINGS, ...settings, ...(g.text ? { guidance: g.text } : {}) }, p, { from: prev.run_no ?? 1, notes, open_points: g.points, overlay_points: g.overlay, kind: "full" });
    res.json({ project: p });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});
/** The points a correction of the active run would look at again. */
app.post("/api/projects/:p/correct/preview", (req, res) => {
  const dir = projectDir(req.params.p);
  const model = readJSON<DrawingModel>(path.join(dir, "drawing.model.json"));
  if (!model) return void res.status(404).json({ error: "no run to correct" });
  const { issues, unplaced } = correctionIssues(dir, model, String(req.body?.notes ?? ""));
  res.json({ points: issues.map((i) => ({ kind: i.kind, text: i.text })), unplaced });
});
/** Keep the active run's reading and look again only at its doubtful spots (made active only when not worse). */
app.post("/api/projects/:p/correct", (req, res) => {
  const p = path.basename(req.params.p);
  try {
    startCorrection(p, String(req.body?.notes ?? ""));
    res.json({ project: p });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});
app.post("/api/projects/:p/runs/:n/activate", (req, res) => {
  const p = path.basename(req.params.p);
  if (activeRuns.has(p)) return void res.status(409).json({ error: "a run is in progress" });
  try {
    activateRun(projectDir(p), Number(req.params.n));
    catalogFromProject(projectDir(p), p); // the cross-project catalog follows the active run
    res.json({ ok: true, runs: listRuns(projectDir(p)) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Read-only SQL against a project's database (SELECT only). */
app.get("/api/projects/:p/table/:t", (req, res) => {
  const file = path.join(projectDir(req.params.p), "database", "pid.sqlite");
  if (!fs.existsSync(file)) return void res.status(404).json({ error: "no database yet" });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    if (!names.includes(req.params.t)) return void res.status(404).json({ error: "unknown table", tables: names });
    res.json({ tables: names, rows: db.prepare(`SELECT * FROM "${req.params.t}"`).all() });
  } finally {
    db.close();
  }
});

function listFiles(dir: string, base = dir): { path: string; bytes: number }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return ["tiles", "work", RUNS_DIR].includes(d.name) ? [] : listFiles(full, base);
    return [{ path: path.relative(base, full), bytes: fs.statSync(full).size }];
  });
}

app.use("/files", express.static(OUTPUT_DIR, { fallthrough: false }));

// ---- runs ----
app.post("/api/runs", (req, res) => {
  const { file, settings, project } = req.body as { file: string; settings?: Partial<RunSettings>; project?: string };
  const src = path.join(INPUT_DIR, path.basename(file ?? ""));
  if (!fs.existsSync(src)) return void res.status(400).json({ error: `Drawing not found in input/: ${file}` });
  try {
    const name = project ? projectName(project) : projectName(src);
    startRun(src, { ...DEFAULT_SETTINGS, ...settings }, name);
    res.json({ project: name });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

// ---- answer keys (reference/keys/<project>.key.json) ----
app.get("/api/keys/:p", (req, res) => {
  const key = readKey(path.basename(req.params.p));
  if (!key) return void res.status(404).json({ error: "no key" });
  res.json(key);
});
app.post("/api/keys/:p/draft", (req, res) => {
  const p = path.basename(req.params.p);
  if (readKey(p)) return void res.status(409).json({ error: "key exists already" });
  const model = readJSON<DrawingModel>(path.join(projectDir(p), "drawing.model.json"));
  if (!model) return void res.status(404).json({ error: "no model to draft from" });
  const run = readJSON<RunState>(path.join(projectDir(p), "run.json"));
  const key = draftKey(p, model, run?.source ?? null);
  writeKey(key);
  res.json(key);
});
app.put("/api/keys/:p", (req, res) => {
  const p = path.basename(req.params.p);
  const key = req.body as AnswerKey;
  if (!key || key.project !== p || !Array.isArray(key.items) || !Array.isArray(key.links)) return void res.status(400).json({ error: "not a key for this project" });
  if (!key.counts) {
    const was = readKey(p)?.counts; // the app does not edit counts: keep them
    if (was) key.counts = was;
  }
  writeKey(key);
  res.json({ ok: true, updated: key.updated });
});
app.get("/api/keys/:p/score", (req, res) => {
  const p = path.basename(req.params.p);
  const key = readKey(p);
  const model = readJSON<DrawingModel>(path.join(projectDir(p), "drawing.model.json"));
  if (!key || !model) return void res.status(404).json({ error: "no key or no model" });
  res.json(scoreModel(key, model));
});

/** Server-sent events: the run state on every log line, then 'end'. */
app.get("/api/projects/:p/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const ctx = activeRuns.get(req.params.p);
  if (!ctx) {
    send("end", readJSON(path.join(projectDir(req.params.p), "run.json")) ?? null);
    return void res.end();
  }
  send("update", ctx.state);
  const onUpdate = (s: RunState) => send("update", s);
  const onEnd = (s: RunState) => {
    send("end", s);
    res.end();
  };
  ctx.events.on("update", onUpdate);
  ctx.events.once("end", onEnd);
  req.on("close", () => {
    ctx.events.off("update", onUpdate);
    ctx.events.off("end", onEnd);
  });
});

// ---- built UI (npm run build) ----
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/files).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

/** Runs left "running" by a process that no longer exists (server restart, killed CLI) are marked failed. */
function markInterruptedRuns() {
  if (!fs.existsSync(OUTPUT_DIR)) return;
  for (const d of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    const f = path.join(OUTPUT_DIR, d.name, "run.json");
    if (!d.isDirectory() || !fs.existsSync(f)) continue;
    const run = readJSON<RunState>(f);
    if (!run || run.status !== "running" || activeRuns.has(d.name)) continue;
    let alive = false;
    if (run.pid && run.pid !== process.pid) {
      try {
        process.kill(run.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) continue;
    const t = new Date().toISOString();
    run.status = "failed";
    run.finished_at = t;
    run.error = "Run interrupted (the process that ran it stopped, e.g. a server restart). Start it again.";
    for (const s of run.stages) if (s.status === "running") s.status = "failed";
    run.log.push({ t, stage: "run", msg: run.error });
    fs.writeFileSync(f, JSON.stringify(run, null, 2));
    console.log(`marked interrupted run: ${d.name}`);
  }
}
markInterruptedRuns();

app.listen(PORT, () => console.log(`P&ID → DEXPI server on http://localhost:${PORT} (model ${MODEL})`));
