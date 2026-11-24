import sharp from "sharp";
import { MODEL_IMAGE_EDGE } from "../config.ts";
import type { BBox } from "../types.ts";

sharp.cache(false);

export interface Region {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crop a page region and scale it so the long edge fits the model limit. Returns PNG + scale. */
export async function cropForModel(pagePath: string, r: { x: number; y: number; w: number; h: number }, edge = MODEL_IMAGE_EDGE) {
  const meta = await sharp(pagePath).metadata();
  const left = Math.max(0, Math.floor(r.x));
  const top = Math.max(0, Math.floor(r.y));
  const width = Math.max(1, Math.min(meta.width! - left, Math.round(r.w)));
  const height = Math.max(1, Math.min(meta.height! - top, Math.round(r.h)));
  const scale = Math.min(1, edge / Math.max(width, height));
  const data = await sharp(pagePath)
    .extract({ left, top, width, height })
    .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: "lanczos3" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return { data, scale };
}

/** Grid of overlapping regions covering a page. */
export function grid(page: number, W: number, H: number, size: number, overlap: number, prefix = "t"): Region[] {
  const step = Math.round(size * (1 - overlap));
  const xs = starts(W, size, step);
  const ys = starts(H, size, step);
  const out: Region[] = [];
  ys.forEach((y, r) =>
    xs.forEach((x, c) => {
      out.push({ id: `${prefix}p${page}_r${r}c${c}`, page, x, y, w: Math.min(size, W - x), h: Math.min(size, H - y) });
    }),
  );
  return out;
}

function starts(total: number, size: number, step: number) {
  if (total <= size) return [0];
  const n = Math.ceil((total - size) / step) + 1;
  const realStep = (total - size) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(i * realStep));
}

/** Split a page into cols×rows regions with a small overlap (used by the audit). */
export function blocks(page: number, W: number, H: number, cols: number, rows: number, overlap = 0.08, prefix = "a"): Region[] {
  const w = W / cols, h = H / rows;
  const ox = w * overlap, oy = h * overlap;
  const out: Region[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, c * w - ox), y = Math.max(0, r * h - oy);
      const x1 = Math.min(W, (c + 1) * w + ox), y1 = Math.min(H, (r + 1) * h + oy);
      out.push({ id: `${prefix}p${page}_r${r}c${c}`, page, x, y, w: x1 - x, h: y1 - y });
    }
  return out;
}

/** Convert a 0–1000 normalized box inside a region back to full-page pixels. */
export function backProject(b: number[], r: { x: number; y: number; w: number; h: number }): BBox {
  const [a, b1, c, d] = (b.length === 4 ? b : [0, 0, 0, 0]).map((v) => Math.max(0, Math.min(1000, v)));
  const x0 = r.x + (Math.min(a, c) / 1000) * r.w;
  const x1 = r.x + (Math.max(a, c) / 1000) * r.w;
  const y0 = r.y + (Math.min(b1, d) / 1000) * r.h;
  const y1 = r.y + (Math.max(b1, d) / 1000) * r.h;
  return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
}

/** Page bbox → 0–1000 box relative to a region (for telling the model where items are). */
export function toRegion(b: BBox, r: { x: number; y: number; w: number; h: number }): number[] {
  return [
    Math.round(((b[0] - r.x) / r.w) * 1000),
    Math.round(((b[1] - r.y) / r.h) * 1000),
    Math.round(((b[2] - r.x) / r.w) * 1000),
    Math.round(((b[3] - r.y) / r.h) * 1000),
  ];
}

export function center(b: BBox): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function inside(b: BBox, r: { x: number; y: number; w: number; h: number }) {
  const [cx, cy] = center(b);
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

/** Fraction of pixels that are clearly coloured (not grey) — tells colour vs monochrome. */
export async function colourFraction(pagePath: string) {
  const { data, info } = await sharp(pagePath).resize(600).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let coloured = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    const mn = Math.min(data[i], data[i + 1], data[i + 2]);
    if (mx - mn > 50) coloured++;
  }
  return coloured / n;
}
