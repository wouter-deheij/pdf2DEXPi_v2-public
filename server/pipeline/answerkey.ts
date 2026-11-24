import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { BBox, Category, DrawingModel } from "../types.ts";
import { normTag } from "./merge.ts";

/**
 * Answer key ("sleutel"): the hand-checked truth for one drawing, kept in reference/keys/ so a new
 * run never overwrites it. A draft is made from the current model; a person then marks every item
 * as right, corrected, not on the drawing, or adds what is missing — in the app's "Sleutel" tab.
 * scoreModel() compares any run's model with it.
 */

export const KEYS_DIR = path.join(ROOT, "reference", "keys");

export type KeyStatus = "unchecked" | "ok" | "fixed" | "added" | "rejected";

export interface KeyItem {
  key: string;
  page: number;
  tag: string | null;
  category: Category;
  type: string;
  dexpi_class: string | null;
  bbox: BBox;
  status: KeyStatus;
  note?: string;
}

/** An instrument link. target: an item key, or a pipe run given by the item keys on/at it. */
export interface KeyLink {
  id: string;
  instrument: string;
  kind: "measures" | "actuates" | "signal";
  target: { item: string } | { run: string[] };
  status: KeyStatus;
}

export interface AnswerKey {
  project: string;
  source: string | null;
  created: string;
  updated: string;
  pages: { n: number; px: [number, number] }[];
  items: KeyItem[];
  links: KeyLink[];
  /** Counted totals (lighter than checking every item); checked by score, compare and every run. */
  counts?: KeyCounts;
}

/**
 * Totals counted by hand on the drawing. Every field is optional: give only what was counted.
 * categories: items per category (equipment, instrument, valve, piping_component, off_page).
 * instruments_by_code: instrument bubbles per printed letter code (PI, TT, LIC …).
 */
export interface KeyCounts {
  source: string; // how and by whom it was counted
  date: string;
  categories?: Partial<Record<Category, number>>;
  instruments_by_code?: Record<string, number>;
}

export interface CountRow {
  what: string;
  expected: number;
  found: number;
  /** ok = equal; near = within 10 % (at least 1); off = further away */
  status: "ok" | "near" | "off";
}

/** Letter code of an instrument as printed (PI-101 → PI, LIC-?-? → LIC). */
export const instrumentCode = (tag: string | null) => (tag ?? "").replace(/\s+/g, "").match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? "?";

/** Compare a model with the counted totals of its key. */
export function checkCounts(counts: KeyCounts, model: DrawingModel): { rows: CountRow[]; ok: boolean; summary: string } {
  const rows: CountRow[] = [];
  const row = (what: string, expected: number, found: number) => {
    const d = Math.abs(found - expected);
    rows.push({ what, expected, found, status: d === 0 ? "ok" : d <= Math.max(1, Math.round(expected * 0.1)) ? "near" : "off" });
  };
  for (const [cat, n] of Object.entries(counts.categories ?? {})) row(cat, n!, model.items.filter((i) => i.category === cat).length);
  const byCode = new Map<string, number>();
  for (const i of model.items) if (i.category === "instrument") byCode.set(instrumentCode(i.tag), (byCode.get(instrumentCode(i.tag)) ?? 0) + 1);
  const codes = counts.instruments_by_code ?? {};
  if (Object.keys(codes).length) {
    for (const [c, n] of Object.entries(codes)) row(`instrument ${c}`, n, byCode.get(c) ?? 0);
    // codes read that the count does not have
    for (const [c, n] of byCode) if (!(c in codes)) row(`instrument ${c}`, 0, n);
  }
  const off = rows.filter((r) => r.status !== "ok");
  const summary = rows.length
    ? off.length
      ? `${rows.length - off.length}/${rows.length} counts right; ${off.map((r) => `${r.what} ${r.found} (expected ${r.expected})`).join(", ")}`
      : `all ${rows.length} counts right`
    : "no counts";
  return { rows, ok: !rows.some((r) => r.status === "off"), summary };
}

export const keyFile = (project: string) => path.join(KEYS_DIR, `${path.basename(project)}.key.json`);

export function readKey(project: string): AnswerKey | null {
  try {
    return JSON.parse(fs.readFileSync(keyFile(project), "utf8"));
  } catch {
    return null;
  }
}

export function writeKey(key: AnswerKey) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  key.updated = new Date().toISOString();
  fs.writeFileSync(keyFile(key.project), JSON.stringify(key, null, 2));
}

/** Members of a run: its components and the items at its two ends. */
const runMembers = (m: DrawingModel, lineId: string) => {
  const l = m.lines.find((x) => x.id === lineId);
  if (!l) return [];
  return [...new Set([l.from.kind !== "line" ? l.from.ref : null, ...l.components, l.to.kind !== "line" ? l.to.ref : null].filter((x): x is string => Boolean(x)))];
};

export function draftKey(project: string, model: DrawingModel, source: string | null): AnswerKey {
  const now = new Date().toISOString();
  const ids = new Set(model.items.map((i) => i.id));
  return {
    project,
    source,
    created: now,
    updated: now,
    pages: model.pages.map((p) => ({ n: p.n, px: p.px })),
    items: model.items.map((i) => ({
      key: i.id,
      page: i.page,
      tag: i.tag,
      category: i.category,
      type: i.type,
      dexpi_class: i.dexpi_class,
      bbox: i.bbox,
      status: "unchecked",
    })),
    links: model.signals
      .filter((s) => ids.has(s.instrument))
      .map((s, k) => ({
        id: `S${k + 1}`,
        instrument: s.instrument,
        kind: s.kind,
        target: (ids.has(s.target) ? { item: s.target } : { run: runMembers(model, s.target) }) as KeyLink["target"],
        status: "unchecked" as KeyStatus,
      }))
      .filter((l) => !("run" in l.target) || l.target.run.length > 0),
  };
}

// ---------------------------------------------------------------- scoring

const centre = (b: BBox) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const area = (b: BBox) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
function iou(a: BBox, b: BBox) {
  const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return i / (area(a) + area(b) - i);
}

export interface PRF {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}
const prf = (tp: number, fp: number, fn: number): PRF => {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +(precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(3) };
};

export interface Score {
  project: string;
  reviewed: number; // share of key items and links that a person has checked
  items: PRF & { by_category: Record<string, PRF> };
  attributes: { matched: number; category: number; tag: number; dexpi_class: number };
  links: PRF;
  missed: string[]; // key items the model did not find
  extra: string[]; // model items that are not on the drawing
  wrong: string[]; // matched, but read differently
}

/**
 * Match the model's items to the key: same page; same tag (normalised) when both carry one and
 * they lie near each other, else the same category with overlapping boxes. Items the key rejects
 * are not truth: a model item matching only those counts as extra.
 */
export function scoreModel(key: AnswerKey, model: DrawingModel): Score {
  const truth = key.items.filter((k) => k.status !== "rejected");
  const diag = (page: number) => {
    const p = key.pages.find((x) => x.n === page);
    return p ? Math.hypot(...p.px) : 5000;
  };
  const pairs: { k: (typeof truth)[number]; m: DrawingModel["items"][number]; s: number }[] = [];
  for (const k of truth)
    for (const m of model.items) {
      if (m.page !== k.page) continue;
      const [kx, ky] = centre(k.bbox), [mx, my] = centre(m.bbox);
      const d = Math.hypot(kx - mx, ky - my);
      const near = d < Math.max(0.6 * Math.max(k.bbox[2] - k.bbox[0], k.bbox[3] - k.bbox[1]), 0.012 * diag(k.page));
      const tk = normTag(k.tag), tm = normTag(m.tag);
      let s = 0;
      if (tk && tm && tk === tm && d < 0.05 * diag(k.page)) s = 3 - d / diag(k.page);
      else if (k.category === m.category && (iou(k.bbox, m.bbox) > 0.25 || near)) s = 2 + iou(k.bbox, m.bbox);
      else if (iou(k.bbox, m.bbox) > 0.4) s = 1 + iou(k.bbox, m.bbox); // same symbol, other category
      if (s) pairs.push({ k, m, s });
    }
  pairs.sort((a, b) => b.s - a.s);
  const k2m = new Map<string, string>(), m2k = new Map<string, string>();
  for (const p of pairs) {
    if (k2m.has(p.k.key) || m2k.has(p.m.id)) continue;
    k2m.set(p.k.key, p.m.id);
    m2k.set(p.m.id, p.k.key);
  }
  const byKey = new Map(key.items.map((k) => [k.key, k]));
  const byId = new Map(model.items.map((m) => [m.id, m]));
  const label = (k: KeyItem) => `${k.tag ?? k.type} (${k.category})`;

  const cats = [...new Set([...truth.map((k) => k.category), ...model.items.map((m) => m.category)])];
  const by_category = Object.fromEntries(
    cats.map((c) => {
      const tp = truth.filter((k) => k.category === c && k2m.has(k.key)).length;
      const fn = truth.filter((k) => k.category === c && !k2m.has(k.key)).length;
      const fp = model.items.filter((m) => m.category === c && !m2k.has(m.id)).length;
      return [c, prf(tp, fp, fn)];
    }),
  );
  let cat = 0, tag = 0, cls = 0;
  const wrong: string[] = [];
  for (const [kk, mid] of k2m) {
    const k = byKey.get(kk)!, m = byId.get(mid)!;
    const okCat = k.category === m.category, okTag = (normTag(k.tag) ?? "") === (normTag(m.tag) ?? ""), okCls = (k.dexpi_class ?? null) === (m.dexpi_class ?? null);
    cat += +okCat;
    tag += +okTag;
    cls += +okCls;
    if (!okCat || !okTag || !okCls)
      wrong.push(`${label(k)}: read as ${m.tag ?? "—"} / ${m.category}${okCls ? "" : ` / ${m.dexpi_class ?? "no class"} (key ${k.dexpi_class ?? "no class"})`}`);
  }

  // links: compare as (instrument, target) in key terms; kind is not scored (signal vs actuates is often a matter of convention)
  const lineMembers = (lineId: string) => runMembers(model, lineId).map((id) => m2k.get(id)).filter((x): x is string => Boolean(x));
  const predicted = model.signals.flatMap((s) => {
    const inst = m2k.get(s.instrument);
    if (!inst) return [];
    if (byId.has(s.target)) {
      const t = m2k.get(s.target);
      return t ? [{ inst, item: t, run: [] as string[] }] : [{ inst, item: `?${s.target}`, run: [] as string[] }];
    }
    return [{ inst, item: null as string | null, run: lineMembers(s.target) }];
  });
  const keyLinks = key.links.filter((l) => l.status !== "rejected");
  const usedPred = new Set<number>();
  let ltp = 0;
  for (const l of keyLinks) {
    const hit = predicted.findIndex(
      (p, i) =>
        !usedPred.has(i) &&
        p.inst === l.instrument &&
        ("item" in l.target ? p.item === l.target.item || p.run.includes(l.target.item) : p.run.some((x) => (l.target as { run: string[] }).run.includes(x)) || (p.item !== null && (l.target as { run: string[] }).run.includes(p.item))),
    );
    if (hit >= 0) {
      usedPred.add(hit);
      ltp++;
    }
  }
  const checked = [...key.items, ...key.links].filter((x) => x.status !== "unchecked").length;
  return {
    project: key.project,
    reviewed: +(checked / Math.max(1, key.items.length + key.links.length)).toFixed(3),
    items: { ...prf(k2m.size, model.items.length - m2k.size, truth.length - k2m.size), by_category },
    attributes: { matched: k2m.size, category: cat, tag, dexpi_class: cls },
    links: prf(ltp, predicted.length - usedPred.size, keyLinks.length - ltp),
    missed: truth.filter((k) => !k2m.has(k.key)).map(label),
    extra: model.items.filter((m) => !m2k.has(m.id)).map((m) => `${m.tag ?? m.type} (${m.category}) ${m.id}`),
    wrong,
  };
}
