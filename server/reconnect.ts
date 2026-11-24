/**
 * Re-run the connect stage (pipe runs + instrument links) of existing projects on their current
 * drawing.model.json — one topology call per page. Then rebuild with `npm run redexpi`.
 * Usage: npm run reconnect -- [--links-only] [project ...]   (no project = all projects)
 *   --links-only: keep the runs, only follow instrument signal lines on zoomed crops
 */
import fs from "node:fs";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { DrawingModel } from "./types.ts";
import { RunContext } from "./pipeline/context.ts";
import { CONNECT_MESSAGES, connect } from "./pipeline/connect.ts";
import { linkInstruments } from "./pipeline/instlinks.ts";
import { computeNets, linkByNets } from "./pipeline/vectorlayer.ts";
import { systemPrompt } from "./pipeline/prompts.ts";

const linksOnly = process.argv.includes("--links-only");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const projects = args.length ? args : fs.readdirSync(OUTPUT_DIR).filter((d) => fs.existsSync(path.join(OUTPUT_DIR, d, "drawing.model.json")));
const readJSON = (f: string, fallback: unknown = undefined) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback);

await Promise.all(
  projects.map(async (p) => {
    const dir = path.join(OUTPUT_DIR, p);
    const runFile = path.join(dir, "run.json");
    const run = readJSON(runFile);
    const ctx = new RunContext(dir, run.settings, { ...run, log: [], usage: { ...run.usage } });
    ctx.persist = () => {};
    const model = readJSON(path.join(dir, "drawing.model.json")) as DrawingModel;
    const costBefore = ctx.state.usage.cost_usd;
    if (linksOnly) {
      model.ambiguities = model.ambiguities.filter((x) => !/^No line from these instruments to a pipe/.test(x.issue));
      const n = model.signals.length;
      // drawn lines first (free), then zoomed crops for what is left
      const pages = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
      const vec = linkByNets(model, computeNets(ctx, model, pages));
      if (vec.length) console.log(`${p}: vector layer linked ${vec.length}: ${vec.join("; ")}`);
      const r = await linkInstruments(ctx, model, systemPrompt(run.settings, model.standard));
      fs.writeFileSync(path.join(dir, "drawing.model.json"), JSON.stringify(model, null, 2));
      run.usage = ctx.state.usage;
      run.log = [...(run.log ?? []), ...ctx.state.log];
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
      console.log(`${p}: ${r.asked} instruments without a path to the process → ${model.signals.length - n} links added, ${r.still ?? 0} still unlinked; cost $${(ctx.state.usage.cost_usd - costBefore).toFixed(2)}`);
      return;
    }
    const before = { lines: model.lines.length, signals: model.signals.length, open: model.ambiguities.length };

    // forget the previous topology: its runs, links, remarks and the symbols it added
    const old = model.pages.flatMap((pg) => (readJSON(path.join(dir, "work", `connect_page${pg.n}.json`), { ambiguities: [] }) as { ambiguities: { tag: string; issue: string }[] }).ambiguities);
    const oldIssues = new Set(old.map((a) => a.issue));
    model.ambiguities = model.ambiguities.filter((a) => !oldIssues.has(a.issue) && !CONNECT_MESSAGES.some((re) => re.test(a.issue)));
    model.items = model.items.filter((i) => !i.sources.every((s) => s.startsWith("connect-")));
    model.lines = [];
    model.signals = [];
    const connectOpen = before.open - model.ambiguities.length;

    ctx.bag.model = model;
    ctx.bag.pages = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, "pages", `page-${pg.n}.png`), rel: "", W: pg.px[0], H: pg.px[1] }));
    ctx.bag.lineLabels = readJSON(path.join(dir, "work", "line_labels.json"), []);
    ctx.bag.localConnections = readJSON(path.join(dir, "work", "local_connections.json"), []);
    ctx.bag.ocrTokens = readJSON(path.join(dir, "work", "ocr_tokens.json"), []);
    await connect(ctx);

    run.usage = ctx.state.usage;
    run.log = [...(run.log ?? []), ...ctx.state.log];
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
    const added = model.items.filter((i) => i.sources.some((s) => s.startsWith("connect-")));
    const now = model.ambiguities.length - (before.open - connectOpen);
    console.log(
      `${p}: runs ${before.lines} → ${model.lines.length}, links ${before.signals} → ${model.signals.length}, connect remarks ${connectOpen} → ${now}; ` +
        `${added.length} symbols added (${added.map((i) => `${i.id}:${i.type}`).join(", ")}); cost $${(ctx.state.usage.cost_usd - costBefore).toFixed(2)}`,
    );
  }),
);
