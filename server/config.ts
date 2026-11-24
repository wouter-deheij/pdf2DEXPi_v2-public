import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..");
export const INPUT_DIR = path.join(ROOT, "input");
export const OUTPUT_DIR = path.join(ROOT, "output");
export const CATALOG_DB = path.join(OUTPUT_DIR, "_catalog.sqlite");
export const PORT = Number(process.env.PID_SERVER_PORT ?? 5175);

/** Model used for every vision call. Override with PID_MODEL. */
export const MODEL = process.env.PID_MODEL ?? "claude-opus-5-5";

/** Approximate list prices (USD per 1M tokens) for the cost estimate in run.json. */
export const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
  "claude-fable-5-2": { in: 8, out: 40, cacheRead: 0.2 },
};

/** Pixels on the long edge of the rasterized page. Small P&ID text needs ~5-6k px. */
export const RASTER_LONG_EDGE = 5600;
/** Long-edge size of each image sent to the model. */
export const MODEL_IMAGE_EDGE = 1568;
/** Tile size (page pixels) and overlap used by the segment step. */
export const TILE_SIZE = 1400;
export const TILE_OVERLAP = 0.2;
/** Parallel model calls. */
export const CONCURRENCY = Number(process.env.PID_CONCURRENCY ?? 4);
