import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../config.ts";
import type { BBox, DrawingModel, Item } from "../types.ts";
import type { RunContext } from "./context.ts";
import type { Region } from "./images.ts";
import { normTag, splitInstrumentTag } from "./merge.ts";

/**
 * Apple Vision OCR (macOS) as a position anchor. The vision model reads symbols well but places
 * boxes loosely; OCR places printed text exactly. Each tagged item is pulled to where its tag is
 * printed, and printed tags the model never reported become review points.
 */

export interface Token {
  page: number;
  text: string;
  norm: string;
  conf: number;
  box: BBox;
  vertical: boolean;
  composite?: boolean;
  /** a real text word of a CAD page whose text layer is complete (every printed tag is a word) */
  complete?: boolean;
}

const SRC = path.join(ROOT, "tools", "vision_ocr.swift");
const BIN = path.join(ROOT, "tools", ".bin", "vision_ocr");

function ensureBinary(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs) {
      fs.mkdirSync(path.dirname(BIN), { recursive: true });
      execFileSync("swiftc", ["-O", SRC, "-o", BIN], { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}

/** Run OCR on the saved tiles and return de-duplicated tokens in page pixels. */
export async function runOcr(ctx: RunContext, tiles: Region[]): Promise<Token[]> {
  if (!ensureBinary()) {
    ctx.log("digitize", "OCR anchor skipped (needs macOS + swiftc)");
    return [];
  }
  const raw: Token[] = [];
  const batch = 8;
  for (let k = 0; k < tiles.length; k += batch) {
    const group = tiles.slice(k, k + batch);
    const files = group.map((t) => ctx.path("tiles", `${t.id}.png`)).filter((f) => fs.existsSync(f));
    let out = "";
    try {
      out = execFileSync(BIN, ["--rotate", ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      ctx.log("digitize", `OCR batch failed: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    for (const line of out.split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as { image: string; width: number; tokens: { text: string; conf: number; box: number[]; vertical: boolean }[] };
      const t = group.find((g) => r.image.endsWith(`${g.id}.png`));
      if (!t) continue;
      const s = t.w / r.width;
      for (const tok of r.tokens) {
        if (tok.conf < 0.3) continue;
        raw.push({
          page: t.page,
          text: tok.text.trim(),
          norm: normTag(tok.text) ?? "",
          conf: tok.conf,
          vertical: tok.vertical,
          box: [t.x + tok.box[0] * s, t.y + tok.box[1] * s, t.x + tok.box[2] * s, t.y + tok.box[3] * s].map(Math.round) as BBox,
        });
      }
    }
  }
  // the same word read in two overlapping tiles → one token
  const tokens: Token[] = [];
  const pageSize = new Map<number, { n: number; W: number; H: number }>();
  for (const t of tiles) {
    const cur = pageSize.get(t.page) ?? { n: t.page, W: 0, H: 0 };
    pageSize.set(t.page, { n: t.page, W: Math.max(cur.W, t.x + t.w), H: Math.max(cur.H, t.y + t.h) });
  }
  for (const t of raw.sort((a, b) => b.conf - a.conf)) {
    if (!t.norm) continue;
    if (tokens.some((o) => o.page === t.page && o.norm === t.norm && iou(o.box, t.box) > 0.3)) continue;
    tokens.push(t);
  }
  return dropEdgeGhosts(tokens, [...pageSize.values()]);
}

/**
 * Vertical text near a tile edge is sometimes placed at the sheet's edge by the rotated OCR pass:
 * a ghost of a reading that also sits at its true spot. A token touching the sheet edge whose text
 * is also read elsewhere on the page is dropped.
 */
export function dropEdgeGhosts(tokens: Token[], pages: { n: number; W: number; H: number }[]): Token[] {
  return tokens.filter((t) => {
    const p = pages.find((x) => x.n === t.page);
    if (!p) return true;
    const m = 0.015 * Math.max(p.W, p.H);
    const atEdge = t.box[0] < m || t.box[1] < m || t.box[2] > p.W - m || t.box[3] > p.H - m;
    if (!atEdge) return true;
    const key = t.norm.replace(/^[^0-9]*?(?=\d)/, ""); // the number part: ghosts often lose a letter
    return !tokens.some((o) => o !== t && o.page === t.page && o.norm.endsWith(key) && key.length >= 3 && !(o.box[1] < m || o.box[0] < m));
  });
}

function iou(a: BBox, b: BBox) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}
const union = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const cx = (b: BBox) => (b[0] + b[2]) / 2;
const cy = (b: BBox) => (b[1] + b[3]) / 2;
const h = (t: Token) => (t.vertical ? t.box[2] - t.box[0] : t.box[3] - t.box[1]);

/**
 * Vision often reads the same printed word twice: once whole and once as a cut-off part
 * ("HSA" and "ISA", "6904" and "904", "PIT" and "F"). A token whose box lies almost wholly inside
 * a larger token on the same text line is such a partial read and is dropped.
 */
export function dropFragments(tokens: Token[]): Token[] {
  const area = (b: BBox) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  const inter = (a: BBox, b: BBox) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return tokens.filter(
    (t) =>
      !tokens.some(
        (o) =>
          o !== t && o.page === t.page && o.vertical === t.vertical && o.conf >= t.conf - 0.2 &&
          area(o.box) > 1.05 * area(t.box) && inter(o.box, t.box) > 0.8 * area(t.box) &&
          Math.abs(h(o) - h(t)) < 0.5 * Math.max(h(o), h(t)) && o.text.replace(/\s/g, "").length >= t.text.replace(/\s/g, "").length,
      ),
  );
}

/** Single words, multi-word lines split into words, and two-line instrument bubbles (letters over number). */
export function expandTokens(input: Token[]): Token[] {
  const tokens = dropFragments(input);
  const out: Token[] = [...tokens];
  for (const t of tokens) {
    const words = t.text.split(/\s+/).filter(Boolean);
    if (words.length > 1 && !t.vertical) {
      const total = t.text.length;
      let pos = 0;
      for (const w of words) {
        const start = t.text.indexOf(w, pos);
        pos = start + w.length;
        const x0 = t.box[0] + ((t.box[2] - t.box[0]) * start) / total;
        const x1 = t.box[0] + ((t.box[2] - t.box[0]) * pos) / total;
        out.push({ ...t, text: w, norm: normTag(w) ?? "", box: [Math.round(x0), t.box[1], Math.round(x1), t.box[3]], composite: true });
      }
      // adjacent word pairs ("PP 711", "CIRC 101")
      for (let i = 0; i + 1 < words.length; i++) {
        const pair = `${words[i]}${words[i + 1]}`;
        out.push({ ...t, text: `${words[i]} ${words[i + 1]}`, norm: normTag(pair) ?? "", composite: true });
      }
    }
  }
  const singles = out.filter((t) => !t.vertical);
  for (const a of singles) {
    if (!/^[A-Z][A-Z0-9]{0,5}$/i.test(a.norm) || /^\d/.test(a.norm)) continue;
    for (const b of singles) {
      if (a === b || a.page !== b.page || !/^\d/.test(b.norm)) continue;
      const lh = Math.max(h(a), h(b));
      const below = b.box[1] - a.box[3];
      const right = b.box[0] - a.box[2];
      // stacked (bubble) or side by side on one line
      if ((below > -0.4 * lh && below < 0.9 * lh && Math.abs(cx(a.box) - cx(b.box)) < 1.2 * lh) || (Math.abs(cy(a.box) - cy(b.box)) < 0.5 * lh && right > -0.2 * lh && right < 1.2 * lh)) {
        out.push({ page: a.page, text: `${a.text}${b.text}`, norm: a.norm + b.norm, conf: Math.min(a.conf, b.conf), box: union(a.box, b.box), vertical: false, composite: true });
      }
    }
  }
  return out.filter((t) => t.norm);
}

const TAGLIKE = /^[A-Z]{1,5}\d{2,4}[A-Z]?$/;

/** Pull tagged items onto their printed tag and report printed tags the model did not list. */
export function anchorItems(model: DrawingModel, tokens: Token[]) {
  if (!tokens.length) return { moved: 0, matched: 0, removed: 0, unlisted: [] as Token[] };
  const all = expandTokens(tokens);
  const byNorm = new Map<string, Token[]>();
  for (const t of all) byNorm.set(t.norm, [...(byNorm.get(t.norm) ?? []), t]);
  let moved = 0, matched = 0;
  const used = new Set<Token>();
  const diagOf = (n: number) => Math.hypot(...model.pages.find((p) => p.n === n)!.px);
  const dist = (it: Item, t: Token) => Math.hypot(cx(t.box) - cx(it.bbox), cy(t.box) - cy(it.bbox));
  // A letters-only tag (TT, PI, LE …) is printed many times. Readings and printed words are paired
  // one-to-one, nearest pairs first, so two readings never claim the same bubble.
  const repeated = (nt: string) => !/\d/.test(nt);
  const pairOf = new Map<Item, Token>();
  const pairs: { it: Item; t: Token; d: number }[] = [];
  for (const it of model.items) {
    const nt = normTag(it.tag);
    if (!nt || !repeated(nt)) continue;
    for (const t of byNorm.get(nt) ?? []) if (t.page === it.page && dist(it, t) <= diagOf(it.page) * 0.12) pairs.push({ it, t, d: dist(it, t) });
  }
  for (const p of pairs.sort((a, b) => a.d - b.d)) {
    if (pairOf.has(p.it) || used.has(p.t)) continue;
    pairOf.set(p.it, p.t);
    used.add(p.t);
  }
  // With real PDF text the printed words are complete: a letters-only instrument reading left
  // without a word while every word of its tag nearby is taken is a second reading of a bubble.
  const dupes = new Set<Item>();
  for (const it of model.items) {
    const nt = normTag(it.tag);
    if (it.category !== "instrument" || !nt || !repeated(nt) || pairOf.has(it)) continue;
    const near = (byNorm.get(nt) ?? []).filter((t) => t.page === it.page && dist(it, t) <= diagOf(it.page) * 0.12);
    if (near.length && near.every((t) => t.complete && used.has(t))) dupes.add(it);
  }
  if (dupes.size) {
    model.items = model.items.filter((i) => !dupes.has(i));
    model.comments.push(`OCR/PDF text: ${dupes.size} repeated readings of letters-only instrument tags removed (every printed ${[...new Set([...dupes].map((d) => d.tag))].join("/")} nearby already has its item)`);
  }
  for (const it of model.items) {
    const nt = normTag(it.tag);
    if (!nt) continue;
    const diag = diagOf(it.page);
    let best: Token | undefined;
    if (repeated(nt)) best = pairOf.get(it);
    else {
      const cands = (byNorm.get(nt) ?? []).filter((t) => t.page === it.page);
      best = cands.sort((a, b) => dist(it, a) - dist(it, b))[0];
      if (best && dist(it, best) > diag * 0.15) best = undefined;
    }
    if (!best) continue;
    const d = (t: Token) => dist(it, t);
    matched++;
    used.add(best);
    const lh = Math.max(12, h(best));
    if (it.category === "instrument") {
      // bubble around the printed letters/number
      const side = Math.max(best.box[2] - best.box[0], best.box[3] - best.box[1]) * 1.45;
      const nb: BBox = [cx(best.box) - side / 2, cy(best.box) - side / 2, cx(best.box) + side / 2, cy(best.box) + side / 2].map(Math.round) as BBox;
      if (Math.hypot(cx(nb) - cx(it.bbox), cy(nb) - cy(it.bbox)) > side * 0.35) moved++;
      it.bbox = nb;
    } else if (d(best) > Math.max(5 * lh, 0.7 * Math.max(it.bbox[2] - it.bbox[0], it.bbox[3] - it.bbox[1]))) {
      // the model's box is not next to the printed tag: trust the print
      const pad = lh * 0.6;
      it.bbox = [best.box[0] - pad, best.box[1] - pad, best.box[2] + pad, best.box[3] + pad].map(Math.round) as BBox;
      it.note = [it.note, "position anchored on the printed tag (OCR)"].filter(Boolean).join("; ");
      moved++;
    }
  }
  return { moved, matched, removed: dupes.size, unlisted: unlistedTags(model, all) };
}

/** Words that appear with a number in notes and labels but are never instrument letters. */
const NOT_TAG_LETTERS = new Set(["TANK", "NK", "POWER", "PEA", "STEAM", "WATER", "FROM", "TO", "ON", "OF", "MM", "HL", "NB", "DN", "OD", "ID", "DE", "SHEET", "DWG", "REV", "PAGE", "NOTE", "MAX", "MIN", "BAR", "KW", "RPM"]);
// alarm letters beside a bubble (SH, JAL, …; OCR reads J as I), not tags — LSL/LSH are real tags
const ALARM = /^[IJ]?(SH|SL|AH|AL|HH|LL|H|L)\d/;

/** OCR confuses O/0, I/L/1, Z/2, Q/0: compare in a folded alphabet. */
const fold = (s: string) => s.replace(/[OQ]/g, "0").replace(/[IL]/g, "1").replace(/Z/g, "2");

// letters OCR swaps for one another inside a bubble
const SWAP = new Set(["HN", "HI", "HZ", "IJ", "EF", "S5", "B8", "Y4", "UV", "Z2"].flatMap((p) => [p, p[1] + p[0]]));

/** Is printed letters/number `t` a typical OCR misread of the item's letters/number `k`? */
function misread(t: { letters: string; number: string }, k: { letters: string; number: string }) {
  const a = t.letters.toUpperCase(), b = k.letters.toUpperCase();
  const diffs = a.length === b.length ? [...a].flatMap((c, i) => (c === b[i] ? [] : [c + b[i]])) : null;
  const letters =
    fold(a) === fold(b) ||
    (diffs?.length === 1 && SWAP.has(diffs[0])) || // one swapped letter (nV ~ HV, hcc ~ ZCC, WEY ~ WE4)
    (b.length >= 3 && fold(a) === fold(b.slice(1))) || // first letter cut off (SOC ~ ZSOC)
    (a.length === b.length + 1 && a.startsWith(b) && /[IJL1]$/.test(a)); // "/" after the letters read as I (SICI ~ SIC)
  const x = fold(t.number.toUpperCase()), y = fold(k.number.toUpperCase());
  const number =
    x === y ||
    (x.length >= 3 && y.length - x.length <= 2 && y.endsWith(x)) || // leading digits cut off (904 ~ 6904)
    (x.length === y.length + 1 && x.startsWith(y)); // one character too many at the end (0019 ~ 001)
  return letters && number;
}

/**
 * Printed, tag-like text that no item claims. A text is claimed by an item with the same tag
 * (OCR-folded), or by a nearby item whose tag is a close misread of it (AUT6903 ~ AUTO6903,
 * TIC0019 ~ TIC001, nV712 ~ HV712). "Nearby" keeps a genuinely missed TIC002 from being
 * explained away by a TIC001 elsewhere on the sheet.
 */
export function unlistedTags(model: DrawingModel, all: Token[]) {
  const tagged = model.items.flatMap((i) => {
    const n = normTag(i.tag);
    return n ? [{ f: fold(n), page: i.page, box: i.bbox, split: splitInstrumentTag(i.tag) }] : [];
  });
  const known = new Set(tagged.map((k) => k.f));
  // drawing number / title / project number printed in the title block are not tags
  const tb = model.title_block;
  const titleText = normTag([tb?.drawing_number, tb?.title, tb?.project_number, tb?.unit].filter(Boolean).join(" ")) ?? "";
  const seen = new Set<string>();
  const grammar = tagGrammar(model);
  return all.filter((t) => {
    if (t.conf < 0.5 || ALARM.test(t.norm) || /\d[.,]\d|\dx\d/i.test(t.text)) return false;
    if (grammar ? !grammar.fits(t.norm) : !TAGLIKE.test(t.norm)) return false;
    if (NOT_TAG_LETTERS.has(t.norm.replace(/\d.*$/, ""))) return false;
    if (titleText.includes(t.norm)) return false;
    if (/\s/.test(t.text) && t.composite && !/^[A-Za-z]+\d/.test(t.text)) return false; // pairs cut from a longer line
    if (!t.composite && /\s/.test(t.text)) return false;
    const f = fold(t.norm);
    if (known.has(f)) return false;
    const page = model.pages.find((p) => p.n === t.page);
    const reach = 0.04 * (page ? Math.hypot(...page.px) : 5000);
    const near = tagged.filter((k) => k.page === t.page && Math.hypot(cx(k.box) - cx(t.box), cy(k.box) - cy(t.box)) < reach);
    const st = splitInstrumentTag(t.norm);
    if (near.some((k) => misread(st, k.split))) return false;
    // the tail of a nearby tag, its leading letters cut off (S09T23 ~ HTJS09T23)
    if (t.norm.length >= 4 && tagged.some((k) => k.page === t.page && k.f.length > t.norm.length && k.f.endsWith(f) && Math.hypot(cx(k.box) - cx(t.box), cy(k.box) - cy(t.box)) < reach)) return false;
    // printed inside an item's own bubble with one character different: a misread of that tag (WEY6905 ~ WE1-6905, TIC0019 ~ TIC001C)
    const inside = (k: (typeof tagged)[number]) => cx(t.box) > k.box[0] && cx(t.box) < k.box[2] && cy(t.box) > k.box[1] && cy(t.box) < k.box[3];
    const oneOff = (x: string, y: string) => x.length === y.length && [...x].filter((c, i) => c !== y[i]).length === 1;
    const L = (x: string) => fold(x.toUpperCase());
    if (near.some((k) => inside(k) && ((L(st.number) === L(k.split.number) && oneOff(L(st.letters), L(k.split.letters))) || (L(st.letters) === L(k.split.letters) && oneOff(L(st.number), L(k.split.number)))))) return false;
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}


/**
 * The tag grammar of this drawing, learnt from the tags the reading found: which shapes occur
 * (number of digits, trailing letter) and how long the letter part is. Every drawing has its own
 * convention (HV712, LE1-6901, N37FT0301, VHE-58P), so a fixed stop-word list cannot separate tags
 * from other printed words (FEED30, NL150, SUITE100, DAY11); the drawing's own tags can.
 * A shape seen fewer than 10 times also needs a first letter seen with it. Too few tags → no grammar.
 */
export function tagGrammar(model: DrawingModel) {
  // shape = letter/digit runs, digits by count: HV712 → A D3, HTJS09T01 → A D2 A D2, VHE58P → A D2 A
  const shape = (n: string) => {
    if (!/^[A-Z]{1,6}\d/.test(n) || n.length > 14) return null;
    const runs = n.match(/[A-Z]+|\d+/g) ?? [];
    if (runs.join("") !== n || runs.length > 5) return null;
    return { letters: runs[0] ?? "", runs: runs.map((r) => r.length), key: runs.map((r) => (/\d/.test(r) ? `D${r.length}` : "A")).join(" ") };
  };
  const stats = new Map<string, { n: number; maxRuns: number[]; first: Set<string> }>();
  let total = 0;
  for (const i of model.items) {
    const sh = shape(normTag(i.tag) ?? "");
    if (!sh) continue;
    total++;
    const st = stats.get(sh.key) ?? { n: 0, maxRuns: sh.runs.map(() => 0), first: new Set<string>() };
    st.n++;
    st.maxRuns = st.maxRuns.map((m, k) => Math.max(m, sh.runs[k]));
    st.first.add(sh.letters[0]);
    stats.set(sh.key, st);
  }
  if (total < 8) return null;
  return {
    shapes: [...stats].map(([k, v]) => `${k}×${v.n}`).join(", "),
    fits(norm: string) {
      const sh = shape(norm);
      const st = sh && stats.get(sh.key);
      if (!sh || !st || st.n < 2) return false;
      if (sh.runs.some((r, k) => r > st.maxRuns[k] + 1)) return false; // a letter run longer than any tag's
      const digits = norm.replace(/\D/g, "").length;
      if (digits < 2 && st.n < 10) return false; // P1, S3: too short to tell from a label
      return st.n >= 10 || st.first.has(sh.letters[0]);
    },
  };
}

const OCR_POINT = "but not in the item list — check whether it is a tag the reading missed or other text.";

/** Replace the model's OCR open points by the current list of unlisted printed tags. */
export function setOcrOpenPoints(model: DrawingModel, unlisted: Token[]) {
  model.ambiguities = model.ambiguities.filter((a) => !a.issue.endsWith(OCR_POINT));
  for (const t of unlisted)
    model.ambiguities.push({ tag: t.text, issue: `Printed at about (${Math.round(cx(t.box))}, ${Math.round(cy(t.box))}) px on page ${t.page} ${OCR_POINT}` });
}
