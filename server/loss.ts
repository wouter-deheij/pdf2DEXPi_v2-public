// Loss analysis: where do the overlay points go? For every drawn process line of the PDF that we
// (partly) miss, the most likely cause; for every route the drawing asks for, how it ended. Runs on
// the stored runs, in memory, without model calls; nothing is written.
//
//   npm run loss                 all projects, summary per project
//   npm run loss -- R9 -v        projects starting with R9, with the largest misses per cause
//
// A drawn net is cut into the pieces between the symbols it joins (the shortest way along the net
// between each two of them). Causes of a missed piece of drawn pipe (solid net reaching a symbol):
//   geen item      the net touches no symbol itself (a connecting piece between other nets)
//   open einde     the piece is not between two symbols (runs to an arrow, text, off-sheet, unread symbol)
//   niet in model  it lies between symbols the model does not join with a pipe
//   route mislukt  the model joins them, but the drawn route was not found (router reason given)
//   geen route     the model joins them, but no route was asked for (drawn as a knee)
//   andere weg     the model joins them and a route was drawn, but not along this piece
// Dashed nets (signal lines) the same, with the model's signal links instead of pipes.
import fs from "node:fs";
import path from "node:path";
import { RunContext } from "./pipeline/context.ts";
import { buildDexpi, pageRouters } from "./pipeline/dexpi.ts";
import { computeNets } from "./pipeline/vectorlayer.ts";
import { overlayScore } from "./pipeline/overlay.ts";
import { judge } from "./pipeline/run.ts";
import type { DrawingModel, Item } from "./types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const verbose = args.includes("-v");
const only = args.filter((a) => !a.startsWith("-"));

const CAUSES = ["geen item", "open: niets gelezen", "open: symbool vlakbij", "open einde", "niet in model", "route mislukt", "geen route", "andere weg"];
type Pt = [number, number];
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const rows: Record<string, string | number>[] = [];
const sigRows: Record<string, string | number>[] = [];
const routeRows: Record<string, string | number>[] = [];
const extraRows: Record<string, string | number>[] = [];
const total = { pipe: new Map<string, number>(), sig: new Map<string, number>(), drawnPipe: 0, drawnSig: 0 };
const details: string[] = [];
const pairMiss = new Map<string, { px: number; cats: string }>();

for (const project of fs.readdirSync(path.join(ROOT, "output")).sort()) {
  if (project.startsWith("_") || (only.length && !only.some((o) => project.startsWith(o)))) continue;
  const dir = path.join(ROOT, "output", project);
  if (!fs.existsSync(path.join(dir, "drawing.model.json")) || !fs.existsSync(path.join(dir, "run.json"))) continue;
  const st = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  const model = JSON.parse(fs.readFileSync(path.join(dir, "drawing.model.json"), "utf8")) as DrawingModel;
  const pages = model.pages.map((pg) => ({ n: pg.n, file: path.join(dir, pg.image), rel: pg.image, W: pg.px[0], H: pg.px[1] }));
  const silent = { value: () => {} };
  const ctx = Object.create(new RunContext(dir, st.settings, st), { writeJSON: silent, writeText: silent, log: silent }) as RunContext;
  await judge(ctx, model, pages);

  // every route the drawing asks for, by item pair
  const itemByBox = new Map(model.items.map((i) => [i.bbox.join(), i.id]));
  const routers = pageRouters(ctx, model);
  const routeCalls = new Map<string, { ok: boolean; why: string }[]>();
  const whyCount = new Map<string, number>();
  for (const [, r] of routers) {
    const wrap = (rt: typeof r) => {
      const orig = rt.route.bind(rt);
      rt.route = (a, b) => {
        const pts = orig(a, b);
        const why = pts ? (rt.why === "partial" ? "partial" : "ok") : rt.why || "?";
        if (rt === r) whyCount.set(why, (whyCount.get(why) ?? 0) + 1);
        const ia = "box" in a ? itemByBox.get(a.box.join()) : undefined, ib = "box" in b ? itemByBox.get(b.box.join()) : undefined;
        if (ia && ib) {
          const k = key(ia, ib);
          (routeCalls.get(k) ?? routeCalls.set(k, []).get(k)!).push({ ok: !!pts && why === "ok", why });
        }
        return pts;
      };
    };
    wrap(r);
    if (r.signal) wrap(r.signal);
  }
  const { svg } = buildDexpi(model, project, "loss", routers);
  const o = await overlayScore(ctx, model, svg);
  if (!o.vector) continue;

  // what the model joins: neighbours along each pipe run, a branch to the run it tees onto, signal links
  const pipePairs = new Set<string>();
  const lineById = new Map(model.lines.map((l) => [l.id, l]));
  const itemIds = new Set(model.items.map((i) => i.id));
  for (const l of model.lines) {
    const seq: string[] = [];
    if (l.from.ref && itemIds.has(l.from.ref)) seq.push(l.from.ref);
    seq.push(...l.components.filter((c) => itemIds.has(c)));
    if (l.to.ref && itemIds.has(l.to.ref)) seq.push(l.to.ref);
    for (let k = 1; k < seq.length; k++) pipePairs.add(key(seq[k - 1], seq[k]));
    for (const [end, near] of [[l.from, seq[0]], [l.to, seq[seq.length - 1]]] as const) {
      if (end.kind !== "line" || !near) continue;
      const run = end.ref ? lineById.get(end.ref) : undefined;
      if (!run) continue;
      const i = end.after ? run.components.indexOf(end.after) : -1;
      for (const c of [run.components[i], run.components[i + 1], i < 0 ? run.from.ref : null]) if (c && itemIds.has(c)) pipePairs.add(key(near, c));
    }
  }
  const sigPairs = new Set(model.signals.map((s) => key(s.instrument, s.target)));

  const nets = computeNets(ctx, model, pages);
  const netById = new Map([...nets.values()].flat().map((n) => [`${n.page}:${n.id}`, n]));
  const items = new Map(model.items.map((i) => [i.id, i]));
  const gap = (q: Pt, b: number[]) => Math.hypot(Math.max(b[0] - q[0], 0, q[0] - b[2]), Math.max(b[1] - q[1], 0, q[1] - b[3]));
  const px = (model.dpi || 200) / 25.4;
  const loss = { pipe: new Map<string, number>(), sig: new Map<string, number>() };
  let drawnPipe = 0, drawnSig = 0;
  const examples: { cause: string; missed: number; page: number; bbox: number[]; items: string[] }[] = [];
  const exact = new Set((model.pipe_routes ?? []).map((r) => key(r.a, r.b)));
  for (const nm of o.nets) {
    if (nm.dash) drawnSig += nm.drawn;
    else drawnPipe += nm.drawn;
    if (!nm.missed) continue;
    const net = netById.get(`${nm.page}:${nm.net}`);
    if (!net) continue;
    // the symbols this net reaches, with where: touched, or an end just short of one (an arrowhead in between)
    const anchors: { item: string; at: Pt }[] = net.touches.map((t) => ({ item: t.item, at: t.at as Pt }));
    for (const q of net.ends) for (const it of model.items) if (it.page === nm.page && gap(q, it.bbox) <= 3 * px && !anchors.some((a) => a.item === it.id)) anchors.push({ item: it.id, at: q });
    // the net as a graph: piece ends closer than 3 px are one node
    const nodes: Pt[] = [];
    const nodeOf = (q: Pt) => {
      let k = nodes.findIndex((n) => Math.abs(n[0] - q[0]) <= 3 && Math.abs(n[1] - q[1]) <= 3);
      if (k < 0) k = nodes.push(q) - 1;
      return k;
    };
    const ends = net.path.map(([a, b]) => [nodeOf(a as Pt), nodeOf(b as Pt)]);
    const adj = nodes.map(() => [] as { to: number; piece: number; d: number }[]);
    ends.forEach(([a, b], j) => {
      const d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
      adj[a].push({ to: b, piece: j, d });
      adj[b].push({ to: a, piece: j, d });
    });
    // a net joins pieces across small gaps: bridge its parts, each time by the shortest gap
    const comp = nodes.map((_, k) => k);
    const find = (k: number): number => (comp[k] === k ? k : (comp[k] = find(comp[k])));
    ends.forEach(([a, b]) => (comp[find(a)] = find(b)));
    for (;;) {
      const root = find(0);
      let best: [number, number, number] | null = null;
      for (let i = 0; i < nodes.length; i++) {
        if (find(i) !== root) continue;
        for (let k = 0; k < nodes.length; k++) {
          if (find(k) === root) continue;
          const d = Math.hypot(nodes[i][0] - nodes[k][0], nodes[i][1] - nodes[k][1]);
          if (!best || d < best[2]) best = [i, k, d];
        }
      }
      if (!best) break;
      adj[best[0]].push({ to: best[1], piece: -1, d: best[2] });
      adj[best[1]].push({ to: best[0], piece: -1, d: best[2] });
      comp[find(best[1])] = root;
    }
    const near = (q: Pt) => {
      let best = 0, bd = Infinity;
      nodes.forEach((n, k) => {
        const d = Math.hypot(n[0] - q[0], n[1] - q[1]);
        if (d < bd) [best, bd] = [k, d];
      });
      return best;
    };
    const at = anchors.map((a) => ({ item: a.item, node: near(a.at) }));
    // each piece: the item pairs whose shortest connection along the net runs over it
    const pairsOf = net.path.map(() => new Set<string>());
    const dists: Map<number, number>[] = [];
    for (let i = 0; i < at.length; i++) {
      const dist = new Map<number, number>([[at[i].node, 0]]), prev = new Map<number, { from: number; piece: number }>();
      dists.push(dist);
      const open = [at[i].node];
      while (open.length) {
        open.sort((x, y) => dist.get(x)! - dist.get(y)!);
        const u = open.shift()!;
        for (const e of adj[u]) {
          const nd = dist.get(u)! + e.d;
          if (nd < (dist.get(e.to) ?? Infinity)) {
            if (!dist.has(e.to)) open.push(e.to);
            dist.set(e.to, nd);
            prev.set(e.to, { from: u, piece: e.piece });
          }
        }
      }
      for (let j = i + 1; j < at.length; j++) {
        if (at[j].item === at[i].item) continue;
        for (let v = at[j].node; prev.has(v); v = prev.get(v)!.from) pairsOf[prev.get(v)!.piece]?.add(key(at[i].item, at[j].item));
      }
    }
    // the core of the net: prune loose branches (a node with one piece that is no symbol) until none is left;
    // a core piece off every shortest connection lies in a loop (a bypass): it joins the nearest symbol on each side
    const deg = nodes.map((_, k) => adj[k].filter((e) => e.piece >= 0).length);
    const anchored = new Set(at.map((a) => a.node));
    const gone = new Set<number>();
    const stack = nodes.map((_, k) => k).filter((k) => deg[k] <= 1 && !anchored.has(k));
    while (stack.length) {
      const k = stack.pop()!;
      for (const e of adj[k]) {
        if (e.piece < 0 || gone.has(e.piece)) continue;
        gone.add(e.piece);
        deg[k]--;
        if (--deg[e.to] <= 1 && !anchored.has(e.to)) stack.push(e.to);
      }
    }
    const nearestItem = (k: number, not?: string) => {
      let best: string | null = null, bd = Infinity;
      at.forEach((a, i) => {
        const d = dists[i].get(k) ?? Infinity;
        if (a.item !== not && d < bd) [best, bd] = [a.item, d];
      });
      return best as string | null;
    };
    ends.forEach(([a, b], j) => {
      if (pairsOf[j].size || gone.has(j)) return;
      const ia = nearestItem(a);
      const ib = ia && nearestItem(b, ia);
      if (ia && ib) pairsOf[j].add(key(ia, ib));
    });
    const m = loss[nm.dash ? "sig" : "pipe"];
    const byCause = new Map<string, number>();
    net.path.forEach((_, j) => {
      const miss = nm.pieces[j] ?? 0;
      if (!miss) return;
      let cause: string;
      const pairs = [...pairsOf[j]];
      if (!anchors.length) cause = "geen item";
      else if (!pairs.length) {
        // what is at the loose end nearest to this piece: a symbol the net does not reach, or nothing read
        const [a, b] = net.path[j];
        const c: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const end = net.ends.reduce<Pt | null>((best, q) => (!best || Math.hypot(q[0] - c[0], q[1] - c[1]) < Math.hypot(best[0] - c[0], best[1] - c[1]) ? (q as Pt) : best), null);
        const W = model.pages.find((p) => p.n === nm.page)!.px[0];
        cause = !end ? "open einde" : model.items.some((it) => it.page === nm.page && gap(end, it.bbox) <= 0.01 * W) ? "open: symbool vlakbij" : "open: niets gelezen";
      }
      else {
        const joined = pairs.filter((p) => (nm.dash ? sigPairs : pipePairs).has(p));
        if (!joined.length) {
          cause = "niet in model";
          if (!nm.dash) for (const pr of pairs) {
            const k = `${project.slice(0, 22)} ${pr}`;
            const e = pairMiss.get(k) ?? pairMiss.set(k, { px: 0, cats: pr.split("|").map((i) => `${items.get(i)?.category}:${items.get(i)?.type}`).join(" — ") }).get(k)!;
            e.px += miss / pairs.length;
          }
        }
        else {
          const calls = joined.flatMap((p) => routeCalls.get(p) ?? []);
          if (!nm.dash && joined.some((p) => exact.has(p))) cause = "andere weg";
          else if (calls.some((c) => c.ok)) cause = "andere weg";
          else if (calls.length) {
            cause = "route mislukt";
            const w = `  ↳ ${calls[0].why}`;
            m.set(w, (m.get(w) ?? 0) + miss);
          } else cause = "geen route";
        }
      }
      m.set(cause, (m.get(cause) ?? 0) + miss);
      byCause.set(cause, (byCause.get(cause) ?? 0) + miss);
    });
    for (const [cause, missed] of byCause)
      examples.push({ cause: `${nm.dash ? "signaal" : "leiding"}: ${cause}`, missed, page: nm.page, bbox: net.bbox, items: [...new Set(anchors.map((a) => a.item))].map((i) => `${i}(${items.get(i)?.type ?? "?"})`) });
  }
  const short = project.slice(0, 22);
  const pct = (v: number, of: number) => (of ? ((100 * v) / of).toFixed(1) : "—");
  const row = (m: Map<string, number>, of: number, label: string, rec: number | null) => {
    const r: Record<string, string | number> = { project: short, [label]: rec == null ? "—" : (100 * rec).toFixed(1) };
    for (const c of CAUSES) r[c] = pct(m.get(c) ?? 0, of);
    return r;
  };
  rows.push(row(loss.pipe, drawnPipe, "gevolgd", o.pipeRecall));
  if (drawnSig) sigRows.push(row(loss.sig, drawnSig, "gevolgd", o.signalRecall));
  // precision: our lines off the drawing (stretches of 40 px or more), by kind
  const ours = o.pages.reduce((t, p) => t + p.ours, 0);
  const ex: Record<string, string | number> = { project: short, "op de PDF": o.precision == null ? "—" : (100 * o.precision).toFixed(1) };
  for (const k of ["pipe", "instrument", "signal"]) ex[k] = pct(o.extras.filter((e) => e.kind === k).reduce((t, e) => t + e.length, 0), ours);
  extraRows.push(ex);
  const calls = [...whyCount.values()].reduce((a, b) => a + b, 0);
  const rr: Record<string, string | number> = { project: short, routes: calls };
  for (const w of ["ok", "partial", "no-path", "shared", "too-long", "no-start-a-box", "no-start-b-box", "no-start-a-pt", "no-start-b-pt"]) rr[w] = whyCount.get(w) ?? 0;
  routeRows.push(rr);
  for (const k of ["pipe", "sig"] as const) for (const [c, v] of loss[k]) total[k].set(c, (total[k].get(c) ?? 0) + v);
  total.drawnPipe += drawnPipe;
  total.drawnSig += drawnSig;
  if (verbose) {
    details.push(`\n${project}`);
    const by = new Map<string, typeof examples>();
    for (const e of examples) (by.get(e.cause) ?? by.set(e.cause, []).get(e.cause)!).push(e);
    for (const [c, es] of [...by].sort((a, b) => b[1].reduce((s, e) => s + e.missed, 0) - a[1].reduce((s, e) => s + e.missed, 0))) {
      details.push(`  ${c}: ${es.reduce((s, e) => s + e.missed, 0)} px`);
      for (const e of es.sort((a, b) => b.missed - a.missed).slice(0, 5)) details.push(`    p${e.page} [${e.bbox.map(Math.round)}] ${e.missed} px  ${e.items.join(", ") || "—"}`);
    }
  }
}

const pct = (v: number, of: number) => (of ? ((100 * v) / of).toFixed(1) : "—");
console.log("\nGemiste getekende leiding, in procentpunten van alle getekende leiding per project:");
console.table(rows);
console.log("Gemiste getekende signaallijn (gestippeld), in procentpunten:");
console.table(sigRows);
console.log("Verzonnen: onze lijnen naast de tekening, in procentpunten van al onze lijnen (pipe / instrument = meetlijn / signal):");
console.table(extraRows);
console.log("Routes die de tekening vraagt (paginarouter), naar uitkomst:");
console.table(routeRows);
const sum = (m: Map<string, number>, of: number) => {
  const main = [...m].filter(([c]) => !c.startsWith(" ")).sort((a, b) => b[1] - a[1]);
  const sub = [...m].filter(([c]) => c.startsWith(" ")).sort((a, b) => b[1] - a[1]);
  return main.flatMap(([c, v]) => [[c, v] as const, ...(c === "route mislukt" ? sub : [])]).map(([c, v]) => `${c.padEnd(16)} ${pct(v, of).padStart(5)} %`).join("\n");
};
console.log(`Alle projecten samen — gemiste leiding (van ${Math.round(total.drawnPipe)} px getekend):\n${sum(total.pipe, total.drawnPipe)}`);
console.log(`\nAlle projecten samen — gemiste signaallijn (van ${Math.round(total.drawnSig)} px getekend):\n${sum(total.sig, total.drawnSig)}`);
if (verbose) console.log(details.join("\n"));
if (args.includes("--pairs")) {
  const byCat = new Map<string, number>();
  for (const e of pairMiss.values()) {
    const k = e.cats.split(" — ").map((c) => c.split(":")[0]).sort().join(" — ");
    byCat.set(k, (byCat.get(k) ?? 0) + e.px);
  }
  console.log("\nNiet in model, per soort paar (px):");
  for (const [k, v] of [...byCat].sort((a, b) => b[1] - a[1])) console.log(`  ${Math.round(v).toString().padStart(6)}  ${k}`);
  console.log("\nNiet in model, grootste paren:");
  for (const [k, e] of [...pairMiss].sort((a, b) => b[1].px - a[1].px).slice(0, 60)) console.log(`  ${Math.round(e.px).toString().padStart(6)}  ${k}  (${e.cats})`);
}
