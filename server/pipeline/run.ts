import fs from "node:fs";
import { overlayScore, overlaySummary, writeOverlay } from "./overlay.ts";
import path from "node:path";
import { MODEL, OUTPUT_DIR } from "../config.ts";
import { STAGES, type RunSettings, type RunState, type StageId } from "../types.ts";
import { RunContext } from "./context.ts";
import { activateRun, archiveActive, clearActive, nextRunNo } from "./runs.ts";
import { correct } from "./correct.ts";
import { catalogFromProject } from "./tabulate.ts";
import type { PageImage } from "./locate.ts";
import { closeOpenEnds, computeNets, applyGeometry, fitBubbles, fitSymbols, joinDrawnPipes, linkByNets, nozzleLabels, placeOrphans, tagsFromText } from "./vectorlayer.ts";
import { locate } from "./locate.ts";
import { digitize } from "./digitize.ts";
import { verify } from "./verify.ts";
import { connect } from "./connect.ts";
import { tabulate } from "./tabulate.ts";
import { buildDexpi, dexpi, pageRouters } from "./dexpi.ts";
import { report } from "./report.ts";
import { checkCounts, readKey } from "./answerkey.ts";
import type { DrawingModel } from "../types.ts";

/** Active runs, so the API can stream progress. */
export const activeRuns = new Map<string, RunContext>();

export function projectName(file: string) {
  return path.basename(file).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

export function startRun(sourcePdf: string, settings: RunSettings, project = projectName(sourcePdf), rerun?: RunState["rerun"]) {
  if (activeRuns.has(project)) throw new Error(`Project ${project} is already running`);
  const dir = path.join(OUTPUT_DIR, project);
  // the previous run is kept in full under runs/run-<n>/; the project folder holds the new one
  archiveActive(dir);
  clearActive(dir);
  fs.mkdirSync(dir, { recursive: true });

  const state: RunState = {
    project,
    source: path.basename(sourcePdf),
    settings,
    model: MODEL,
    status: "running",
    pid: process.pid,
    started_at: new Date().toISOString(),
    stages: STAGES.map((s) => ({ id: s.id, status: "pending" })),
    log: [],
    usage: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 },
    run_no: nextRunNo(dir),
    ...(rerun ? { rerun } : {}),
  };
  const ctx = new RunContext(dir, settings, state);
  activeRuns.set(project, ctx);
  const done = execute(ctx, sourcePdf).finally(() => {
    activeRuns.delete(project);
    try {
      archiveActive(dir);
    } catch (e) {
      console.error(`keeping run ${state.run_no} of ${project} failed: ${(e as Error).message}`);
    }
    ctx.events.emit("end", ctx.state);
  });
  return { ctx, done };
}

async function execute(ctx: RunContext, sourcePdf: string) {
  const steps: Record<StageId, () => unknown> = {
    locate: () => locate(ctx, sourcePdf),
    digitize: () => digitize(ctx),
    verify: () => verify(ctx),
    connect: () => connect(ctx),
    tabulate: () => tabulate(ctx),
    dexpi: () => dexpi(ctx),
    report: () => report(ctx),
  };
  if (ctx.state.rerun) ctx.log("run", `re-run ${ctx.state.run_no} from run ${ctx.state.rerun.from ?? "—"}: ${ctx.state.rerun.open_points} open points, ${ctx.state.rerun.overlay_points} overlay points${ctx.state.rerun.notes.trim() ? ", engineer's notes" : ""} given as hints`);
  ctx.log("run", `start: ${ctx.state.source} → output/${ctx.state.project} (run ${ctx.state.run_no}, model ${MODEL}, depth ${ctx.settings.depth}, standard ${ctx.settings.standard}, effort ${ctx.settings.effort})`);
  for (const st of ctx.state.stages) {
    st.status = "running";
    st.started_at = new Date().toISOString();
    ctx.log(st.id, "started");
    try {
      await steps[st.id]();
      st.status = st.id === "verify" && ctx.settings.depth === "fast" ? "skipped" : "done";
      st.finished_at = new Date().toISOString();
      ctx.log(st.id, "done");
    } catch (e) {
      st.status = "failed";
      st.note = (e as Error).message;
      st.finished_at = new Date().toISOString();
      ctx.state.status = "failed";
      ctx.state.error = `${st.id}: ${(e as Error).message}`;
      ctx.state.finished_at = new Date().toISOString();
      ctx.log(st.id, `FAILED: ${(e as Error).message}`);
      console.error(e);
      return ctx.state;
    }
  }
  ctx.state.status = "done";
  ctx.state.score = ctx.bag.score as number;
  ctx.state.finished_at = new Date().toISOString();
  // counted totals of the answer key, when there are any: a reading that lost or doubled symbols shows here
  const counts = readKey(ctx.state.project)?.counts;
  if (counts && ctx.bag.model) {
    const c = checkCounts(counts, ctx.bag.model as DrawingModel);
    ctx.log("run", `reference counts ${c.ok ? "✓" : "✗"} ${c.summary}`);
  }
  // overlay of our DEXPI drawing on the PDF's drawn lines (vector layer)
  if (ctx.bag.model) {
    try {
      const o = await writeOverlay(ctx, ctx.bag.model as DrawingModel);
      if (o?.vector) ctx.log("run", `overlay: ${overlaySummary(o)}`);
    } catch (e) {
      ctx.log("run", `overlay skipped: ${(e as Error).message}`);
    }
  }
  ctx.log("run", `finished — cost ≈ $${ctx.state.usage.cost_usd.toFixed(2)} for ${ctx.state.usage.calls} calls`);
  return ctx.state;
}

// ---------------------------------------------------------------- correction run

const readJSON = <T,>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
/** How a run compares: how well its drawing lies on the PDF (mean of precision and pipe recall) and its open points. */
function standing(dir: string) {
  const ov = readJSON<{ vector: boolean; precision: number | null; pipeRecall: number | null }>(path.join(dir, "overlay.json"));
  const ans = readJSON<{ unresolved: unknown[] }>(path.join(dir, "drawing.answer.json"));
  const fit = ov?.vector && ov.precision !== null && ov.pipeRecall !== null ? (ov.precision + ov.pipeRecall) / 2 : null;
  return { fit, open: ans?.unresolved.length ?? null };
}

/**
 * A correction of the active run: its reading is kept and only the spots that checking it found
 * (open points, overlay, the engineer's notes) are looked at again, zoomed in. It is made active only
 * when its drawing lies on the PDF at least as well and it has no more open points; otherwise the run
 * it started from stays active and the correction is kept beside it.
 */
export function startCorrection(project: string, notes: string) {
  if (activeRuns.has(project)) throw new Error(`Project ${project} is already running`);
  const dir = path.join(OUTPUT_DIR, project);
  const prev = readJSON<RunState>(path.join(dir, "run.json"));
  if (!prev || prev.status !== "done" || !fs.existsSync(path.join(dir, "drawing.model.json"))) throw new Error("A correction starts from a finished run; this project has none active.");
  const base = archiveActive(dir)!;
  const before = standing(dir);
  const { guidance: _g, ...settings } = prev.settings;
  const state: RunState = {
    project,
    source: prev.source,
    settings,
    model: MODEL,
    status: "running",
    pid: process.pid,
    started_at: new Date().toISOString(),
    stages: STAGES.map((s) => ({ id: s.id, status: "pending" })),
    log: [],
    usage: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 },
    run_no: nextRunNo(dir),
    rerun: { from: base, notes, open_points: before.open ?? 0, overlay_points: 0, kind: "correction" },
  };
  const ctx = new RunContext(dir, settings, state);
  activeRuns.set(project, ctx);
  ctx.persist();
  const done = executeCorrection(ctx, base, before, notes).finally(() => {
    activeRuns.delete(project);
    try {
      archiveActive(dir);
      if (state.rerun?.accepted === false) {
        activateRun(dir, base);
        catalogFromProject(dir, project);
      }
    } catch (e) {
      console.error(`keeping correction ${state.run_no} of ${project} failed: ${(e as Error).message}`);
    }
    ctx.events.emit("end", ctx.state);
  });
  return { ctx, done };
}

/** The vector layer over a read model: bubbles, tags from text, drawn nets, routes. */
function vectorPass(ctx: RunContext, model: DrawingModel, pages: PageImage[]) {
  fitBubbles(ctx, model, pages);
  fitSymbols(ctx, model, pages);
  tagsFromText(ctx, model, pages);
  const nets = computeNets(ctx, model, pages);
  if (!nets.size) return;
  const fixes = [...closeOpenEnds(model, nets), ...placeOrphans(model, nets), ...joinDrawnPipes(model, nets), ...linkByNets(model, nets)];
  if (fixes.length) ctx.log("connect", `vector layer: ${fixes.join("; ")}`);
  const again = computeNets(ctx, model, pages);
  const g = applyGeometry(model, again);
  nozzleLabels(ctx, model, pages, again);
  ctx.log("connect", `vector layer: ${g.signalLines} drawn signal lines, ${g.routes} exact pipe routes, ${g.taps} tap points`);
}

/**
 * How well a model's drawing would lie on the PDF — vector layer, DEXPI drawing and overlay, all in
 * memory and without logging (the same fit the correction guard uses). It changes the model it gets.
 */
export async function judge(ctx: RunContext, model: DrawingModel, pages: PageImage[]): Promise<number | null> {
  const quiet = Object.create(ctx, { log: { value: () => {} } }) as RunContext;
  vectorPass(quiet, model, pages);
  const { svg } = buildDexpi(model, ctx.state.project, "judge", pageRouters(quiet, model));
  const o = await overlayScore(quiet, model, svg);
  return o.vector && o.precision !== null && o.pipeRecall !== null ? (o.precision + o.pipeRecall) / 2 : null;
}

async function executeCorrection(ctx: RunContext, base: number, before: { fit: number | null; open: number | null }, notes: string) {
  const model = JSON.parse(fs.readFileSync(ctx.path("drawing.model.json"), "utf8")) as DrawingModel;
  const pages: PageImage[] = model.pages.map((pg) => ({ n: pg.n, file: ctx.path(pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
  ctx.bag.model = model;
  ctx.bag.pages = pages;
  ctx.bag.profile = JSON.parse(fs.readFileSync(ctx.path("drawing.profile.json"), "utf8"));
  ctx.bag.score = readJSON<{ confidence: number }>(ctx.path("drawing.answer.json"))?.confidence ?? 0;
  const stage = (id: StageId) => ctx.state.stages.find((s) => s.id === id)!;
  for (const id of ["locate", "digitize"] as StageId[]) Object.assign(stage(id), { status: "skipped", note: `reading of run ${base} kept` });
  ctx.log("run", `correction ${ctx.state.run_no} of run ${base}: its reading is kept; only its open points, overlay deviations${notes.trim() ? " and the engineer's notes" : ""} are looked at again`);
  const steps: [StageId, () => unknown][] = [
    [
      "verify",
      async () => {
        const r = await correct(ctx, model, pages, notes, (m) => judge(ctx, m, pages));
        ctx.state.rerun!.overlay_points = r.points;
        stage("verify").note = `${r.points} points: ${r.resolved} resolved, ${r.wasRight} were right, ${r.open} open${r.rejected.length ? `; ${r.rejected.length} changes not kept (overlay worse)` : ""}`;
        ctx.log("verify", `correction: ${r.points} points → ${r.resolved} resolved, ${r.wasRight} were right, ${r.open} still open; ${r.findings} item corrections, ${r.runsChanged} runs changed${r.rejected.length ? `; ${r.rejected.length} not kept (overlay worse)` : ""}${r.notes.length ? `: ${r.notes.join("; ")}` : ""}`);
      },
    ],
    [
      "connect",
      () => {
        // the drawn lines again, as after a reading: items and runs may have changed
        vectorPass(ctx, model, pages);
        ctx.writeJSON("drawing.model.json", model);
      },
    ],
    ["tabulate", () => tabulate(ctx)],
    ["dexpi", () => dexpi(ctx)],
    ["report", () => report(ctx)],
  ];
  for (const [id, fn] of steps) {
    const st = stage(id);
    st.status = "running";
    st.started_at = new Date().toISOString();
    try {
      await fn();
      st.status = "done";
      st.finished_at = new Date().toISOString();
      ctx.log(id, "done");
    } catch (e) {
      Object.assign(st, { status: "failed", note: (e as Error).message, finished_at: new Date().toISOString() });
      Object.assign(ctx.state, { status: "failed", error: `${id}: ${(e as Error).message}`, finished_at: new Date().toISOString() });
      ctx.state.rerun!.accepted = false;
      ctx.state.rerun!.verdict = `failed in ${id}; run ${base} stays active`;
      ctx.log(id, `FAILED: ${(e as Error).message}`);
      console.error(e);
      return ctx.state;
    }
  }
  try {
    const o = await writeOverlay(ctx, model);
    if (o?.vector) ctx.log("run", `overlay: ${overlaySummary(o)}`);
  } catch (e) {
    ctx.log("run", `overlay skipped: ${(e as Error).message}`);
  }
  // only better (or equal) replaces the run it started from
  const after = standing(ctx.dir);
  const p = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const fitOk = before.fit === null || after.fit === null || after.fit >= before.fit - 0.002;
  const openOk = before.open === null || after.open === null || after.open <= before.open;
  ctx.state.rerun!.accepted = fitOk && openOk;
  ctx.state.rerun!.verdict = `overlay ${p(before.fit)} → ${p(after.fit)}, open points ${before.open ?? "—"} → ${after.open ?? "—"}: ${fitOk && openOk ? "at least as good — made active" : `${!fitOk ? "the drawing lies less well on the PDF" : "more open points"} — run ${base} stays active`}`;
  ctx.state.status = "done";
  ctx.state.score = ctx.bag.score as number;
  ctx.state.finished_at = new Date().toISOString();
  ctx.log("run", `verdict: ${ctx.state.rerun!.verdict}`);
  ctx.log("run", `finished — cost ≈ $${ctx.state.usage.cost_usd.toFixed(2)} for ${ctx.state.usage.calls} calls`);
  return ctx.state;
}
