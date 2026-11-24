import { execFileSync } from "node:child_process";
import type { BBox } from "../types.ts";
import { bridgeHops } from "./hops.ts";

/**
 * Vector layer. Most P&ID PDFs come out of CAD: every pipe and signal line is an exact path, and
 * often the text is real text. Poppler renders the page to SVG (pdftocairo, page rotation applied)
 * and lists the words with their boxes (pdftotext -bbox); both are mapped to the raster's pixels.
 * A scanned sheet gives nothing here and the pipeline falls back to vision alone.
 */

export interface Seg {
  a: [number, number];
  b: [number, number];
  w: number; // stroke width in px
  curve: boolean; // chord of a Bézier piece (circles, arcs) — not a pipe
  dash: boolean; // drawn with a dash pattern (or rebuilt from separate dashes)
  path: number; // index of the source path
  hop?: true; // straight piece added across a line hop (see hops.ts), not drawn as such
}
export interface VWord {
  text: string;
  box: BBox;
}
export interface VectorPage {
  n: number;
  kind: "vector" | "raster";
  scale: number; // px per pt
  segs: Seg[];
  fills: BBox[]; // boxes of filled-only shapes (outlined text, arrowheads, solid symbols)
  words: VWord[];
}

type M = [number, number, number, number, number, number];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const attr = (tag: string, name: string) => {
  const r = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return r ? r[1] : null;
};

/** Parse the absolute M/L/C/Z path data cairo writes (H/V/relative forms handled too, for safety). */
function pathPieces(d: string): { pts: [number, number][]; curve: boolean[] }[] {
  const toks = d.match(/[MLCZHVmlczhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const subs: { pts: [number, number][]; curve: boolean[] }[] = [];
  let cur: { pts: [number, number][]; curve: boolean[] } | null = null;
  let x = 0, y = 0, sx = 0, sy = 0, cmd = "";
  let i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        sx = x;
        sy = y;
        cur = { pts: [[x, y]], curve: [] };
        subs.push(cur);
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        cur?.pts.push([x, y]);
        cur?.curve.push(false);
        break;
      }
      case "H": {
        const nx = num();
        x = rel ? x + nx : nx;
        cur?.pts.push([x, y]);
        cur?.curve.push(false);
        break;
      }
      case "V": {
        const ny = num();
        y = rel ? y + ny : ny;
        cur?.pts.push([x, y]);
        cur?.curve.push(false);
        break;
      }
      case "C": {
        const c = [num(), num(), num(), num(), num(), num()];
        const ex = rel ? x + c[4] : c[4], ey = rel ? y + c[5] : c[5];
        x = ex;
        y = ey;
        cur?.pts.push([x, y]);
        cur?.curve.push(true);
        break;
      }
      case "Z": {
        if (cur && (x !== sx || y !== sy)) {
          cur.pts.push([sx, sy]);
          cur.curve.push(false);
        }
        x = sx;
        y = sy;
        cmd = "";
        break;
      }
      default:
        i++; // unknown token: skip
    }
  }
  return subs;
}

export function extractVectorPage(pdf: string, n: number, px: [number, number]): VectorPage {
  let svg = "";
  try {
    svg = execFileSync("pdftocairo", ["-svg", "-f", String(n), "-l", String(n), pdf, "-"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return { n, kind: "raster", scale: 1, segs: [], fills: [], words: [] };
  }
  const head = /<svg[^>]*width="([\d.]+)pt"[^>]*height="([\d.]+)pt"/.exec(svg);
  const wPt = head ? Number(head[1]) : px[0];
  const scale = px[0] / wPt;
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "").replace(/<clipPath[\s\S]*?<\/clipPath>/g, "").replace(/<pattern[\s\S]*?<\/pattern>/g, "");

  const segs: Seg[] = [];
  const fills: BBox[] = [];
  let k = 0;
  for (const m of body.matchAll(/<path\b[^>]*>/g)) {
    const tag = m[0];
    const d = attr(tag, "d");
    if (!d) continue;
    const t = attr(tag, "transform");
    const mt: M = t ? (t.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)!.slice(0, 6).map(Number) as M) : [1, 0, 0, 1, 0, 0];
    const stroke = attr(tag, "stroke");
    const stroked = stroke !== null && stroke !== "none";
    const fill = attr(tag, "fill");
    const pieces = pathPieces(d);
    const idx = k++;
    const toPx = (p: [number, number]): [number, number] => {
      const [X, Y] = apply(mt, p[0], p[1]);
      return [X * scale, Y * scale];
    };
    if (stroked) {
      const dashed = Boolean(attr(tag, "stroke-dasharray"));
      const sw = Number(attr(tag, "stroke-width") ?? 1) * Math.sqrt(Math.abs(mt[0] * mt[3] - mt[1] * mt[2])) * scale;
      for (const s of pieces)
        for (let j = 1; j < s.pts.length; j++) {
          const a = toPx(s.pts[j - 1]), b = toPx(s.pts[j]);
          if (a[0] === b[0] && a[1] === b[1]) continue;
          segs.push({ a, b, w: +sw.toFixed(2), curve: s.curve[j - 1], dash: dashed, path: idx });
        }
    } else if (fill !== "none") {
      const all = pieces.flatMap((s) => s.pts.map(toPx));
      if (all.length) {
        const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
        fills.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
  }
  const words = extractWords(pdf, n, scale);
  const kind = segs.length > 50 || words.length > 20 ? "vector" : "raster";
  // a pipe that jumps over another line is one drawn line: bridge the arc with a straight piece
  if (kind === "vector") {
    const { bridges, drop } = bridgeHops(segs, px[0]);
    const kept = drop.size ? segs.filter((s) => !drop.has(s.path)) : segs;
    return { n, kind, scale, segs: [...kept, ...bridges], fills, words };
  }
  return { n, kind, scale, segs, fills, words };
}

/** Words with boxes from pdftotext -bbox (coordinates in the rotated page, like pdftocairo). */
export function extractWords(pdf: string, n: number, scale: number): VWord[] {
  let html = "";
  try {
    html = execFileSync("pdftotext", ["-bbox", "-f", String(n), "-l", String(n), pdf, "-"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  const out: VWord[] = [];
  for (const m of html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
    const text = m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (!text) continue;
    out.push({ text, box: [Number(m[1]) * scale, Number(m[2]) * scale, Number(m[3]) * scale, Number(m[4]) * scale] });
  }
  return out;
}
