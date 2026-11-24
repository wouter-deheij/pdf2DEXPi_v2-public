import { loadVector, mergeWordTokens, vectorSummary } from "./vectorlayer.ts";
import { TILE_OVERLAP, TILE_SIZE } from "../config.ts";
import { callJSON } from "../llm.ts";
import { FatalApiError } from "../llm.ts";
import type { BBox, Category, DrawingModel, Item, TitleBlock, Answer } from "../types.ts";
import type { RunContext } from "./context.ts";
import { backProject, cropForModel, grid, type Region } from "./images.ts";
import type { PageImage } from "./locate.ts";
import { mergeCandidates, splitInstrumentTag, describeIsa, type Candidate } from "./merge.ts";
import { systemPrompt, TILE_SCHEMA, tilePrompt } from "./prompts.ts";
import { writeDrawingXml } from "./xml.ts";
import { anchorItems, runOcr, type Token } from "./ocr.ts";
import { readMajorEquipment, reconcileMajor } from "./major.ts";

interface TileItem {
  tag: string | null;
  category: Category;
  type: string;
  dexpi_class: string | null;
  description: string | null;
  service: string | null;
  size: string | null;
  line_ref: string | null;
  actuator: string | null;
  color: string | null;
  bbox: number[];
  confidence: number;
  cut_at_edge: boolean;
}
export interface TileReply {
  items: TileItem[];
  line_labels: { text: string; line_id: string | null; size: string | null; spec: string | null; service: string | null; bbox: number[] }[];
  connections: { from: string; to: string; via: string | null }[];
  notes: string[];
}

export interface LineLabel {
  page: number;
  text: string;
  line_id: string | null;
  size: string | null;
  spec: string | null;
  service: string | null;
  bbox: BBox;
}

export async function digitize(ctx: RunContext) {
  const pages = ctx.bag.pages as PageImage[];
  const standard = ctx.bag.standard as string;
  const system = systemPrompt(ctx.settings, standard);
  const tiles: Region[] = pages.flatMap((p) => grid(p.n, p.W, p.H, TILE_SIZE, TILE_OVERLAP));
  ctx.log("digitize", `${tiles.length} tiles of ${TILE_SIZE}px with ${TILE_OVERLAP * 100}% overlap`);
  ctx.ensureDir("tiles");
  ctx.writeJSON("tiles/index.json", tiles);

  const failed: string[] = [];
  // whole-sheet look for equipment larger than a tile, in parallel with the tiles
  const majorP = readMajorEquipment(ctx, pages, system);
  const replies = await Promise.all(
    tiles.map(async (t) => {
      const page = pages.find((p) => p.n === t.page)!;
      const img = await cropForModel(page.file, t);
      ctx.writeText(`tiles/${t.id}.png`, img.data);
      try {
        const r = await callJSON<TileReply>(ctx, {
          stage: "digitize",
          label: `tile ${t.id}`,
          system,
          prompt: tilePrompt(t.id, `page ${t.page}, region x=${t.x}..${t.x + t.w}, y=${t.y}..${t.y + t.h} of ${page.W}×${page.H}px`),
          images: [{ data: img.data, mediaType: "image/png" }],
          schema: TILE_SCHEMA,
          effort: ctx.settings.effort,
        });
        ctx.writeJSON(`tiles/${t.id}.json`, r);
        return { tile: t, reply: r };
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        failed.push(t.id);
        ctx.log("digitize", `tile ${t.id} FAILED: ${(e as Error).message}`);
        return { tile: t, reply: null };
      }
    }),
  );

  // back-project to page pixels
  const cands: Candidate[] = [];
  const labels: LineLabel[] = [];
  const localConnections: { page: number; from: string; to: string; via: string | null }[] = [];
  for (const { tile, reply } of replies) {
    if (!reply) continue;
    for (const it of reply.items) {
      const bbox = backProject(it.bbox, tile);
      const cx = (it.bbox[0] + it.bbox[2]) / 2000 - 0.5;
      const cy = (it.bbox[1] + it.bbox[3]) / 2000 - 0.5;
      cands.push({
        page: tile.page,
        tag: it.tag,
        category: it.category,
        type: it.type,
        dexpi_class: it.dexpi_class,
        description: it.description,
        service: it.service,
        size: it.size,
        line_ref: it.line_ref,
        actuator: it.actuator,
        loop: null,
        color: it.color,
        bbox,
        confidence: it.confidence,
        sources: [tile.id],
        cut_at_edge: it.cut_at_edge,
        edge_score: Math.hypot(cx, cy),
      });
    }
    for (const l of reply.line_labels) labels.push({ page: tile.page, ...l, bbox: backProject(l.bbox, tile) });
    for (const c of reply.connections) localConnections.push({ page: tile.page, ...c });
  }
  const items = mergeCandidates(cands, pages.map((p) => [p.W, p.H]));
  const major = await majorP;
  ctx.log("digitize", reconcileMajor(items, major));
  enrichInstruments(items);

  // dedupe line labels by text+proximity
  const uniqLabels: LineLabel[] = [];
  for (const l of labels) {
    if (!uniqLabels.some((u) => u.page === l.page && u.text === l.text && Math.abs(u.bbox[0] - l.bbox[0]) < 150 && Math.abs(u.bbox[1] - l.bbox[1]) < 150)) uniqLabels.push(l);
  }

  const model: DrawingModel = {
    document: (ctx.bag.profile as { file: string }).file,
    pages: pages.map((p) => ({ n: p.n, px: [p.W, p.H], image: p.rel })),
    dpi: (ctx.bag.profile as { dpi: number }).dpi,
    standard: standard as Answer["standard"],
    title_block: ctx.bag.titleBlock as TitleBlock,
    items,
    lines: [],
    signals: [],
    ambiguities: failed.map((id) => ({ tag: `tile ${id}`, issue: "This tile could not be read; items in this region may be missing — re-run or check by hand." })),
    comments: [`first-pass merge of ${cands.length} tile detections from ${tiles.length - failed.length}/${tiles.length} tiles`],
  };
  // OCR anchor: exact positions for printed tags, and tags the model missed
  // words that are real text in the PDF are exact: they replace the OCR readings at the same spot
  const vector = loadVector(ctx, pages);
  ctx.log("digitize", `vector layer: ${vectorSummary(vector)}`);
  const merged = mergeWordTokens(await runOcr(ctx, tiles), vector);
  const tokens = merged.tokens;
  ctx.writeJSON("work/ocr_tokens.json", tokens);
  ctx.bag.ocrTokens = tokens;
  if (tokens.length) {
    const a = anchorItems(model, tokens);
    ctx.bag.ocrUnlisted = a.unlisted;
    ctx.log("digitize", `OCR: ${tokens.length} text tokens; ${a.matched} tags located, ${a.moved} boxes moved, ${a.removed} repeated readings removed; ${a.unlisted.length} printed tag-like texts not in the item list`);
  }

  ctx.bag.model = model;
  ctx.bag.lineLabels = uniqLabels;
  ctx.bag.localConnections = localConnections;
  ctx.writeJSON("work/candidates.json", cands);
  ctx.writeJSON("work/line_labels.json", uniqLabels);
  ctx.writeJSON("work/local_connections.json", localConnections);
  ctx.writeJSON("drawing.model.first_pass.json", model);
  writeDrawingXml(ctx, model, "drawing.xml");

  const count = (c: Category) => model.items.filter((i) => i.category === c).length;
  ctx.log(
    "digitize",
    `MergeSummary: ${cands.length} detections → ${model.items.length} items (equipment ${count("equipment")}, instruments ${count("instrument")}, valves ${count("valve")}, piping components ${count("piping_component")}, off-page ${count("off_page")}); ${uniqLabels.length} line labels; ${failed.length} failed tiles`,
  );
  return model;
}

/**
 * Loop number + readable function for instrument bubbles.
 * A tag read as "LE16901" where the sheet's loops are 69xx was "LE1" printed over "6901":
 * when the number is 1–2 digits longer than a loop number used by other bubbles on the same
 * page and ends with it, the extra leading digits belong to the function part (LE1-6901).
 */
export function enrichInstruments(items: Item[]) {
  const ins = items.filter((i) => i.category === "instrument" && i.tag);
  const count = new Map<string, number>();
  for (const it of ins) {
    const n = splitInstrumentTag(it.tag).number;
    if (n.length >= 3) count.set(`${it.page}|${n}`, (count.get(`${it.page}|${n}`) ?? 0) + 1);
  }
  for (const it of ins) {
    const s = splitInstrumentTag(it.tag);
    if (!s.number || /[\s\-_/]/.test(it.tag!) || (count.get(`${it.page}|${s.number}`) ?? 0) > 1) continue;
    for (const k of [1, 2]) {
      const loop = s.number.slice(k);
      if (loop.length >= 3 && /^\d+$/.test(s.number.slice(0, k)) && (count.get(`${it.page}|${loop}`) ?? 0) >= 2) {
        const fixed = `${s.letters}${s.number.slice(0, k)}-${loop}`;
        it.note = [it.note, `tag read as ${it.tag}; split as ${fixed} (loop ${loop} is used on this sheet)`].filter(Boolean).join("; ");
        it.tag = fixed;
        break;
      }
    }
  }
  for (const it of items) {
    if (it.category !== "instrument") continue;
    const { letters, number } = splitInstrumentTag(it.tag);
    it.loop = number || null;
    if (!it.type || it.type === "instrument") it.type = letters || "instrument";
    if (!it.description) it.description = describeIsa(letters);
    it.dexpi_class = null;
  }
}
