import type { BBox, Category, Item } from "../types.ts";
import { center } from "./images.ts";

/** Normalised tag used for de-duplication only (the printed tag is kept as-is). */
export function normTag(tag: string | null | undefined) {
  if (!tag) return null;
  const t = tag.toUpperCase().replace(/[\s\-_./]/g, "");
  return t.length ? t : null;
}

function iou(a: BBox, b: BBox) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (area(a) + area(b) - inter);
}

/** Coarse equipment family of a snake_case type, so near-synonyms (motor/agitator) compare equal. */
export function family(type: string | null | undefined) {
  const t = (type ?? "").toLowerCase();
  if (/ferment|bioreact|vessel|tank|reactor|column|tower|drum|silo|receiver/.test(t)) return "vessel";
  if (/agitat|stirr|impeller|mixer|motor|drive/.test(t)) return "agitator";
  if (/exchang|condens|cooler|heater|evaporat/.test(t)) return "exchanger";
  if (/pump/.test(t)) return "pump";
  if (/filter|strainer/.test(t)) return "filter";
  if (/bottle|container|pot|can\b|jerrycan/.test(t)) return "container";
  return t || "?";
}
export const sameKind = (a: string | null | undefined, b: string | null | undefined) => family(a) === family(b);

const isFlat = (b: BBox) => b[2] - b[0] < 8 || b[3] - b[1] < 8;

function area(b: BBox) {
  return Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
}

function dist(a: BBox, b: BBox) {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  return Math.hypot(ax - bx, ay - by);
}

/** Size-relative proximity threshold for untagged symbols. */
function nearEnough(a: BBox, b: BBox, pageDiag: number) {
  const size = Math.max(Math.sqrt(area(a)), Math.sqrt(area(b)));
  return dist(a, b) < Math.max(size * 0.9, pageDiag * 0.004);
}

const PRIORITY: Category[] = ["equipment", "valve", "instrument", "piping_component", "off_page"];

export interface Candidate extends Omit<Item, "id"> {
  cut_at_edge?: boolean;
  /** untagged reading folded into a tagged item: never decides its box or attributes */
  absorbed?: boolean;
  /** distance of the item centre to its tile centre, 0..1 — lower = more trustworthy bbox */
  edge_score?: number;
}

/**
 * Deduplicate candidates from overlapping tiles:
 *  - same page + same normalised tag → one item (tags with a number are unique on a sheet; a
 *    letters-only tag such as TT or PI is not, and merges only with readings at the same spot),
 *  - untagged symbols of the same category whose centres are close → one item.
 * The surviving record takes the best-confidence attributes and the bbox seen
 * most centrally in a tile (least likely to be cut).
 */
/** Intersection as a share of the smaller box. */
function overlapOfSmaller(a: BBox, b: BBox) {
  const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const s = Math.min(Math.max(1, (a[2] - a[0]) * (a[3] - a[1])), Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
  return i / s;
}

/**
 * Tags that can be printed more than once on one sheet, so that a second reading elsewhere is a
 * second symbol: letters-only instrument tags (TT, PI, LE …) and off-page connector names (three
 * connectors "VTK-16H1 TJ HTR CD TNK" for three condensate lines). Other tags are unique per sheet.
 */
export const repeatsOnSheet = (nt: string, category?: string) => !/\d/.test(nt) || category === "off_page";

export function mergeCandidates(cands: Candidate[], pagesPx: [number, number][]): Item[] {
  const groups: Candidate[][] = [];
  const byTag = new Map<string, Candidate[]>();
  // a box clamped flat on a tile border (the model placed the symbol outside its tile) says nothing
  // about where a letters-only tag is: such readings join the nearest proper reading afterwards
  const flat = isFlat;
  const later: Candidate[] = [];
  for (const c of cands) {
    const nt = normTag(c.tag);
    if (nt && !/\d/.test(nt) && flat(c.bbox)) {
      later.push(c);
      continue;
    }
    if (nt && repeatsOnSheet(nt, c.category)) {
      // letters only (TT, PI, LE …) or a connector name: not unique on the sheet — the same symbol only at the same spot
      const [W, H] = pagesPx[c.page - 1] ?? [5000, 5000];
      const diag = Math.hypot(W, H);
      // connectors are often stacked a box apart at the sheet edge: for them the same spot means real overlap
      const same = (o: Candidate) =>
        c.category === "off_page"
          ? overlapOfSmaller(o.bbox, c.bbox) >= 0.5 || ((isFlat(o.bbox) || isFlat(c.bbox)) && dist(o.bbox, c.bbox) < 400) // a box clamped flat on a tile edge is no spot of its own
          : iou(o.bbox, c.bbox) >= 0.2 || nearEnough(o.bbox, c.bbox, diag);
      const g = groups.find((g) => g[0].page === c.page && g[0].category === c.category && normTag(g[0].tag) === nt && g.some(same));
      if (g) g.push(c);
      else groups.push([c]);
      continue;
    }
    if (nt) {
      const key = `${c.page}|${nt}`;
      const g = byTag.get(key);
      if (g) g.push(c);
      else {
        const ng = [c];
        byTag.set(key, ng);
        groups.push(ng);
      }
      continue;
    }
    const [W, H] = pagesPx[c.page - 1] ?? [5000, 5000];
    const diag = Math.hypot(W, H);
    const g = groups.find(
      (g) => !normTag(g[0].tag) && g[0].page === c.page && g[0].category === c.category && g.some((o) => nearEnough(o.bbox, c.bbox, diag)),
    );
    if (g) g.push(c);
    else groups.push([c]);
  }

  for (const c of later) {
    const nt = normTag(c.tag);
    const near = groups
      .filter((g) => g[0].page === c.page && normTag(g[0].tag) === nt && !flat(g[0].bbox))
      .map((g) => ({ g, d: Math.min(...g.map((o) => dist(o.bbox, c.bbox))) }))
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 300) near.g.push(c);
    else if (!groups.some((g) => g[0].page === c.page && normTag(g[0].tag) === nt)) groups.push([c]); // the only reading of this tag
    // otherwise a flat reading with no proper one near it: a clamped ghost of a symbol outside its tile
  }

  // an untagged reading is the same symbol as a tagged one of the same category only when the boxes
  // really overlap, or when it is the same kind of thing close by and not much bigger. Merely lying
  // next to a tag is not enough: the R9 agitator motor sits beside the CO800 condenser tag.
  const tagged = groups.filter((g) => normTag(g[0].tag));
  const merged: Candidate[][] = [];
  for (const g of groups) {
    if (normTag(g[0].tag)) {
      merged.push(g);
      continue;
    }
    const [W, H] = pagesPx[g[0].page - 1] ?? [5000, 5000];
    const host = tagged.find((t) => t[0].page === g[0].page && t[0].category === g[0].category && t.some((o) => g.some((c) => iou(o.bbox, c.bbox) >= 0.25 || (sameKind(o.type, c.type) && nearEnough(o.bbox, c.bbox, Math.hypot(W, H) * 0.5) && area(c.bbox) <= 2.5 * area(o.bbox)))));
    if (host) host.push(...g.map((c) => ({ ...c, tag: host[0].tag, absorbed: true })));
    else merged.push(g);
  }

  const items: Item[] = merged.map((g) => {
    const own = g.filter((c) => !c.absorbed);
    const best = [...(own.length ? own : g)].sort((a, b) => b.confidence - a.confidence)[0];
    const bboxSrc = pickBox(own.length ? own : g);
    const pick = <K extends keyof Candidate>(k: K) => (best[k] ?? g.find((c) => c[k] != null)?.[k] ?? null) as Candidate[K];
    // category: majority vote, ties by priority
    const votes = new Map<Category, number>();
    g.forEach((c) => votes.set(c.category, (votes.get(c.category) ?? 0) + c.confidence));
    const category = [...votes.entries()].sort((a, b) => b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]))[0][0];
    const conf = Math.min(0.99, best.confidence + (g.length > 1 ? 0.02 : 0));
    return {
      id: "",
      page: best.page,
      tag: best.tag?.trim() || null,
      category,
      type: best.type,
      dexpi_class: pick("dexpi_class"),
      description: pick("description"),
      service: pick("service"),
      size: pick("size"),
      line_ref: pick("line_ref"),
      actuator: pick("actuator"),
      loop: null,
      color: pick("color"),
      bbox: bboxSrc.bbox,
      confidence: Number(conf.toFixed(2)),
      sources: [...new Set(g.flatMap((c) => c.sources))],
      note: g.find((c) => c.note)?.note,
    };
  });
  assignIds(items);
  return items;
}

/**
 * Choose the bbox the tiles agree on most: among the uncut readings, the medoid (smallest summed
 * centre distance to the others). Ties and single readings fall back to the most central reading.
 */
function pickBox(g: Candidate[]): Candidate {
  const real = g.filter((c) => !isFlat(c.bbox)); // a box clamped flat on a tile border is no position
  if (real.length && real.length < g.length) g = real;
  const pool = g.filter((c) => !c.cut_at_edge);
  const cands = pool.length ? pool : g;
  if (cands.length <= 2) return [...cands].sort((a, b) => (a.edge_score ?? 0) - (b.edge_score ?? 0))[0];
  let best = cands[0], bestScore = Infinity;
  for (const c of cands) {
    const s = cands.reduce((acc, o) => acc + dist(c.bbox, o.bbox), 0) + (c.edge_score ?? 0) * 10;
    if (s < bestScore) [best, bestScore] = [c, s];
  }
  return best;
}

const PREFIX: Record<Category, string> = { equipment: "EQ", instrument: "I", valve: "V", piping_component: "PC", off_page: "OPC" };

/** Ids: the printed tag where there is one (made XML-safe), otherwise a category counter in reading order. */
export function assignIds(items: Item[]) {
  const used = new Set<string>();
  const counters: Record<string, number> = {};
  const sorted = [...items].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  for (const it of sorted) {
    let base = it.tag ? safeId(it.tag) : "";
    if (!base || /^\d/.test(base)) base = it.tag ? `${PREFIX[it.category]}-${safeId(it.tag)}` : "";
    if (!base) {
      counters[it.category] = (counters[it.category] ?? 0) + 1;
      base = `${PREFIX[it.category]}-auto-${String(counters[it.category]).padStart(3, "0")}`;
    }
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    it.id = id;
  }
}

export function safeId(s: string) {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Analysis prefixes written before the function letters (O2E 001, pHT 101, CO2 IT 5). */
const CHEM = /^(CO2|NH3|CL2|O2|H2|N2|CO|PH|DO)(?=[A-Z])/i;

/**
 * Instrument tag → function part + loop number, plus the ISA category and function letters.
 *  "TIC 101A" → TIC / 101A;   "LE1-6901" → LE1 / 6901 (LE1 = level element no. 1);
 *  "O2E001"  → O2E / 001 (analysis, element);   "PIC801" → PIC / 801.
 * A fused tag such as "LE16901" (LE1 printed over 6901) is resolved by enrichInstruments,
 * which knows the loop numbers used on the sheet.
 */
export function splitInstrumentTag(tag: string | null) {
  const empty = { letters: "", number: "", category: "", functions: "", chem: "" };
  if (!tag) return empty;
  const t = tag.trim();
  let letters = "", number = "";
  const sep = t.match(/^(.*?[A-Za-z][A-Za-z0-9]*)[\s\-_/]+(\d[\dA-Za-z]*)$/);
  if (sep) [letters, number] = [sep[1].replace(/[\s\-_/]/g, ""), sep[2]];
  else {
    const c = t.replace(/[\s\-_/]/g, "");
    const m = c.match(/^([A-Za-z][A-Za-z0-9]*?[A-Za-z])(\d+[A-Za-z]?)$/) ?? c.match(/^([A-Za-z])(\d+[A-Za-z]?)$/);
    if (m) [letters, number] = [m[1], m[2]];
    else letters = c.replace(/\d+$/, "");
  }
  const chem = letters.match(CHEM)?.[1] ?? "";
  const fn = letters.slice(chem.length).replace(/\d+/g, "").toUpperCase();
  return chem ? { letters, number, category: "A", functions: fn, chem } : { letters, number, category: fn.slice(0, 1), functions: fn.slice(1), chem };
}

const FIRST: Record<string, string> = {
  A: "Analysis", B: "Burner/combustion", C: "User's choice (conductivity)", D: "User's choice (density)", E: "Voltage", F: "Flow", G: "User's choice (gauging/position)",
  H: "Hand", I: "Current", J: "Power", K: "Time", L: "Level", M: "User's choice (moisture)", N: "User's choice", O: "User's choice", P: "Pressure",
  Q: "Quantity", R: "Radiation", S: "Speed/frequency", T: "Temperature", U: "Multivariable", V: "Vibration", W: "Weight/force", X: "Unclassified", Y: "Event/state", Z: "Position",
};
const SUCC: Record<string, string> = {
  A: "alarm", C: "controller", E: "element", G: "glass/gauge", H: "high", I: "indicator", K: "control station", L: "low", O: "orifice", Q: "totalizer",
  R: "recorder", S: "switch", T: "transmitter", V: "valve", Y: "relay/compute", Z: "driver/actuator", D: "differential", F: "ratio", P: "test point",
};

/** Human-readable ISA function, e.g. "PIC" → "Pressure indicator controller". */
export function describeIsa(letters: string) {
  if (!letters) return null;
  const s = splitInstrumentTag(`${letters} 1`);
  if (s.chem) return `${s.chem.toUpperCase() === "PH" ? "pH" : s.chem.toUpperCase()} analysis ${[...s.functions].map((c) => SUCC[c] ?? c).join(" ")}`.trim();
  const L = s.category + s.functions;
  if (!L) return null;
  const first = FIRST[L[0]];
  if (!first) return null;
  return [first, ...[...L.slice(1)].map((c) => SUCC[c] ?? c)].join(" ");
}
