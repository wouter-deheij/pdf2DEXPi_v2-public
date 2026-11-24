import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CATALOG_DB } from "../config.ts";
import type { DrawingModel, Endpoint, Item, Profile } from "../types.ts";
import type { RunContext } from "./context.ts";

type Row = Record<string, string | number | null>;
export type Tables = Record<string, Row[]>;

const ep = (e: Endpoint, model: DrawingModel) => {
  if (e.kind === "line") return `branch of ${e.ref}${e.after ? ` after ${e.after}` : ""}`;
  if (e.kind === "open") return e.ref ? `open (${e.ref})` : "open end";
  const it = model.items.find((i) => i.id === e.ref);
  return `${it?.tag ?? e.ref ?? ""}${e.nozzle ? ` ${e.nozzle}` : ""}`;
};

const bboxCols = (i: Item) => ({ page: i.page, x0: i.bbox[0], y0: i.bbox[1], x1: i.bbox[2], y1: i.bbox[3] });

/** Build the row sets once; CSV, per-project SQLite and the catalog all use them. */
export function buildTables(model: DrawingModel, project: string, score: number, profile: Profile): Tables {
  const of = (c: Item["category"]) => model.items.filter((i) => i.category === c);
  const nozzles = new Map<string, number>();
  for (const l of model.lines)
    for (const e of [l.from, l.to]) if (e.kind === "equipment" && e.ref) nozzles.set(e.ref, (nozzles.get(e.ref) ?? 0) + 1);
  const lineOf = (id: string) => model.lines.find((l) => l.components.includes(id));
  const sig = (id: string, kind: string) =>
    model.signals
      .filter((s) => s.instrument === id && s.kind === kind)
      .map((s) => model.items.find((i) => i.id === s.target)?.tag ?? model.lines.find((l) => l.id === s.target)?.line_id ?? s.target)
      .join(", ") || null;
  const tb = model.title_block;

  return {
    drawing: [
      {
        project,
        document: model.document,
        drawing_number: tb.drawing_number,
        title: tb.title,
        revision: tb.revision,
        sheet: tb.sheet,
        date: tb.date,
        unit: tb.unit,
        plant: tb.plant,
        project_number: tb.project_number,
        author: tb.author,
        client: tb.client,
        standard: model.standard,
        confidence: score,
        pages: model.pages.length,
        dpi: model.dpi,
        has_text_layer: profile.has_text_layer ? 1 : 0,
        colour: profile.color ? 1 : 0,
        created_at: new Date().toISOString(),
      },
    ],
    equipment: of("equipment").map((i) => ({
      id: i.id, tag: i.tag, type: i.type, dexpi_class: i.dexpi_class, description: i.description, service: i.service,
      nozzle_count: nozzles.get(i.id) ?? 0, confidence: i.confidence, ...bboxCols(i), note: i.note ?? null,
    })),
    instruments: of("instrument").map((i) => ({
      id: i.id, tag: i.tag, type: i.type, function: i.description, loop: i.loop, service: i.service,
      line: sig(i.id, "measures") ?? i.line_ref, actuates: sig(i.id, "actuates"), signals_to: sig(i.id, "signal"),
      confidence: i.confidence, ...bboxCols(i), note: i.note ?? null,
    })),
    valves: of("valve").map((i) => ({
      id: i.id, tag: i.tag, type: i.type, dexpi_class: i.dexpi_class, size: i.size,
      line_id: lineOf(i.id)?.line_id ?? lineOf(i.id)?.id ?? i.line_ref, actuator: i.actuator, service: i.service,
      confidence: i.confidence, ...bboxCols(i), note: i.note ?? null,
    })),
    piping_components: of("piping_component").map((i) => ({
      id: i.id, tag: i.tag, type: i.type, dexpi_class: i.dexpi_class, size: i.size,
      line_id: lineOf(i.id)?.line_id ?? lineOf(i.id)?.id ?? i.line_ref, service: i.service,
      confidence: i.confidence, ...bboxCols(i), note: i.note ?? null,
    })),
    off_page_connectors: of("off_page").map((i) => ({
      id: i.id, tag: i.tag, type: i.type, description: i.description, service: i.service, confidence: i.confidence, ...bboxCols(i),
    })),
    lines: model.lines.map((l) => ({
      id: l.id, line_id: l.line_id, size: l.size, spec: l.spec, service: l.service,
      from: ep(l.from, model), to: ep(l.to, model), insulation: l.insulation,
      component_count: l.components.length, confidence: l.confidence, page: l.page,
    })),
    line_components: model.lines.flatMap((l) =>
      l.components.map((c, n) => ({ line: l.id, seq: n + 1, item_id: c, tag: model.items.find((i) => i.id === c)?.tag ?? null })),
    ),
    signals: model.signals.map((s) => ({ instrument: s.instrument, kind: s.kind, target: s.target, basis: s.basis ?? "drawn", via: s.via ?? null })),
    signal_lines: (model.signal_lines ?? []).map((l) => {
      const tagOf = (id?: string) => (id ? model.items.find((i) => i.id === id)?.tag ?? id : null);
      return {
        id: l.id, page: l.page, type: l.type, pattern: l.pattern, bus: l.bus ? 1 : 0,
        instruments: l.ends.filter((e) => e.item && model.items.find((i) => i.id === e.item)?.category === "instrument").map((e) => tagOf(e.item)).join(" | ") || null,
        other_ends: l.ends.filter((e) => e.line || (e.item && model.items.find((i) => i.id === e.item)?.category !== "instrument")).map((e) => e.line ?? tagOf(e.item)).join(" | ") || null,
        loose_ends: l.ends.filter((e) => !e.item && !e.line).length,
        signals_carried: model.signals.filter((s) => s.via === l.id).length,
        length_px: Math.round(l.length),
      };
    }),
    unresolved: model.ambiguities.map((a) => ({ tag: a.tag, issue: a.issue })),
  };
}

function csv(rows: Row[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

function colType(rows: Row[], c: string) {
  const v = rows.find((r) => r[c] !== null && r[c] !== undefined)?.[c];
  return typeof v === "number" ? (Number.isInteger(v) ? "INTEGER" : "REAL") : "TEXT";
}

function writeDb(db: DatabaseSync, tables: Tables, project: string | null) {
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("BEGIN");
  try {
    for (const [name, rows] of Object.entries(tables)) {
      if (!rows.length) {
        // keep an empty table so queries never fail
        db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${project !== null ? '"project" TEXT, ' : ""}"id" TEXT)`);
        if (project !== null) db.prepare(`DELETE FROM "${name}" WHERE project = ?`).run(project);
        continue;
      }
      const cols = Object.keys(rows[0]).filter((c) => c !== "project");
      const all = project !== null ? ["project", ...cols] : Object.keys(rows[0]);
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${all.map((c) => `"${c}" ${c === "project" ? "TEXT" : colType(rows, c)}`).join(", ")})`);
      // add columns that a newer pipeline version introduced
      const existing = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((r) => r.name));
      for (const c of all) if (!existing.has(c)) db.exec(`ALTER TABLE "${name}" ADD COLUMN "${c}" ${colType(rows, c)}`);
      if (project !== null) db.prepare(`DELETE FROM "${name}" WHERE project = ?`).run(project);
      const stmt = db.prepare(`INSERT INTO "${name}" (${all.map((c) => `"${c}"`).join(", ")}) VALUES (${all.map(() => "?").join(", ")})`);
      for (const r of rows) stmt.run(...all.map((c) => (c === "project" ? project : (r[c] ?? null))));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function tabulate(ctx: RunContext) {
  const model = ctx.bag.model as DrawingModel;
  const tables = buildTables(model, ctx.state.project, (ctx.bag.score as number) ?? 0, ctx.bag.profile as Profile);
  ctx.ensureDir("tables");
  for (const [name, rows] of Object.entries(tables)) ctx.writeText(`tables/${name}.csv`, csv(rows));

  // per-project database (rebuilt every run)
  ctx.ensureDir("database");
  const dbFile = ctx.path("database", "pid.sqlite");
  fs.rmSync(dbFile, { force: true });
  const db = new DatabaseSync(dbFile);
  writeDb(db, tables, null);
  db.close();

  // cross-project catalog: same tables with a project column, upserted per project
  const cat = new DatabaseSync(CATALOG_DB);
  writeDb(cat, tables, ctx.state.project);
  cat.close();

  ctx.bag.tables = tables;
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  ctx.writeJSON("tables/counts.json", counts);
  ctx.log("tabulate", `tables: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; database/pid.sqlite + output/_catalog.sqlite updated`);
  return tables;
}

/** Put a project's tables (from its own database) into the cross-project catalog: after another run is made active. */
export function catalogFromProject(dir: string, project: string) {
  const file = path.join(dir, "database", "pid.sqlite");
  if (!fs.existsSync(file)) return;
  const src = new DatabaseSync(file, { readOnly: true });
  const tables: Tables = {};
  try {
    for (const { name } of src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) tables[name] = src.prepare(`SELECT * FROM "${name}"`).all() as Row[];
  } finally {
    src.close();
  }
  const cat = new DatabaseSync(CATALOG_DB);
  try {
    writeDb(cat, tables, project);
  } finally {
    cat.close();
  }
}
