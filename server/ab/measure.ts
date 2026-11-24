// Measures every project with the pipeline code found under CODE_ROOT, on the stored runs under
// DATA_ROOT/output, entirely in memory (nothing is written to the runs). Used by `npm run ab`.
//
//   tsx server/ab/measure.ts CODE_ROOT DATA_ROOT OUT.json [project-prefix ...]
import fs from "node:fs";
import path from "node:path";

export interface Measure {
  precision: number | null;
  pipeRecall: number | null;
  signalRecall: number | null;
  routed: number | null;
  routes: number | null;
  noPath: number | null;
  error?: string;
}

const [CODE, DATA, OUT, ...only] = process.argv.slice(2);
if (!CODE || !DATA || !OUT) {
  console.error("usage: tsx server/ab/measure.ts CODE_ROOT DATA_ROOT OUT.json [project-prefix ...]");
  process.exit(2);
}
const mod = (p: string) => import(path.join(CODE, "server", "pipeline", p));
const { RunContext } = await mod("context.ts");
const { buildDexpi, pageRouters } = await mod("dexpi.ts");
const { overlayScore } = await mod("overlay.ts");
const { judge } = await mod("run.ts");

const root = path.join(DATA, "output");
const res: Record<string, Measure> = {};
for (const project of fs.readdirSync(root).sort()) {
  if (project.startsWith("_") || (only.length && !only.some((o) => project.startsWith(o)))) continue;
  const dir = path.join(root, project);
  if (!fs.existsSync(path.join(dir, "drawing.model.json")) || !fs.existsSync(path.join(dir, "run.json"))) continue;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8"));
    const pages = model.pages.map((pg: any) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
    const silent = { value: () => {} };
    const ctx = Object.create(new RunContext(dir, st.settings, st), { writeJSON: silent, writeText: silent, log: silent });
    await judge(ctx, model, pages); // the vector pass, as a run does it
    const { svg, warnings } = buildDexpi(model, project, "ab", pageRouters(ctx, model));
    const o = await overlayScore(ctx, model, svg);
    if (!o.vector) continue; // raster drawings have no overlay score
    const w: string = warnings.find((x: string) => x.includes("drawn along their PDF route")) ?? "";
    const m = w.match(/(\d+) of (\d+)/);
    res[project] = {
      precision: o.precision,
      pipeRecall: o.pipeRecall,
      signalRecall: o.signalRecall,
      routed: m ? +m[1] : null,
      routes: m ? +m[2] : null,
      noPath: m ? +(w.match(/no-path (\d+)/)?.[1] ?? 0) : null,
    };
  } catch (e) {
    res[project] = { precision: null, pipeRecall: null, signalRecall: null, routed: null, routes: null, noPath: null, error: String((e as Error).message ?? e).slice(0, 200) };
  }
}
fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
