import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { RASTER_LONG_EDGE } from "../config.ts";
import { callJSON } from "../llm.ts";
import type { Profile, TitleBlock, Answer } from "../types.ts";
import type { RunContext } from "./context.ts";
import { colourFraction, cropForModel } from "./images.ts";
import { PROFILE_PROMPT, PROFILE_SCHEMA, systemPrompt } from "./prompts.ts";

export interface PageImage {
  n: number;
  file: string; // absolute
  rel: string; // relative to project dir
  W: number;
  H: number;
}

interface ProfileReply {
  title_block: TitleBlock;
  standard: Answer["standard"];
  standard_cues: string[];
  is_pid: boolean;
  legend_present: boolean;
  notes: string[];
}

function pdfinfo(file: string) {
  const out = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const get = (k: string) => out.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1] ?? "";
  const size = get("Page size").match(/([\d.]+) x ([\d.]+)/);
  return {
    pages: Number(get("Pages") || 1),
    size: [Number(size?.[1] ?? 0), Number(size?.[2] ?? 0)] as [number, number],
    rotation: Number(get("Page rot") || 0),
  };
}

export async function locate(ctx: RunContext, sourcePdf: string) {
  // 1. stage the file in the project
  if (!fs.existsSync(sourcePdf)) throw new Error(`Drawing not found: ${sourcePdf}`);
  const ext = path.extname(sourcePdf).toLowerCase();
  const staged = ctx.path("source", path.basename(sourcePdf));
  ctx.ensureDir("source");
  if (path.resolve(sourcePdf) !== path.resolve(staged)) fs.copyFileSync(sourcePdf, staged);
  const bytes = fs.statSync(staged).size;
  ctx.ensureDir("pages");

  // 2. rasterize
  let pages: PageImage[] = [];
  let info = { pages: 1, size: [0, 0] as [number, number], rotation: 0 };
  let dpi = 0;
  let hasText = false;
  if (ext === ".pdf") {
    info = pdfinfo(staged);
    dpi = Math.round(RASTER_LONG_EDGE / (Math.max(...info.size) / 72));
    ctx.log("locate", `PDF: ${info.pages} page(s), ${info.size[0]}×${info.size[1]} pt, rotation ${info.rotation}°, rasterizing at ${dpi} dpi`);
    execFileSync("pdftoppm", ["-r", String(dpi), "-png", staged, ctx.path("pages", "page")]);
    hasText = execFileSync("pdftotext", [staged, "-"], { encoding: "utf8" }).replace(/\s/g, "").length > 20;
    const files = fs.readdirSync(ctx.path("pages")).filter((f) => /^page-\d+\.png$/.test(f)).sort();
    for (const f of files) {
      const n = Number(f.match(/(\d+)/)![1]);
      const target = `page-${n}.png`;
      if (f !== target) fs.renameSync(ctx.path("pages", f), ctx.path("pages", target));
      pages.push({ n, file: ctx.path("pages", target), rel: `pages/${target}`, W: 0, H: 0 });
    }
  } else if ([".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(ext)) {
    const target = ctx.path("pages", "page-1.png");
    await sharp(staged).png().toFile(target);
    pages.push({ n: 1, file: target, rel: "pages/page-1.png", W: 0, H: 0 });
    dpi = 200;
  } else {
    throw new Error(`Unsupported file type ${ext}`);
  }
  for (const p of pages) {
    const m = await sharp(p.file).metadata();
    p.W = m.width!;
    p.H = m.height!;
    if (!fs.statSync(p.file).size) throw new Error(`Rasterized page ${p.n} is empty`);
    // small preview for the UI
    await sharp(p.file).resize(1800).jpeg({ quality: 85 }).toFile(ctx.path("pages", `page-${p.n}.preview.jpg`));
  }
  pages = pages.sort((a, b) => a.n - b.n);
  const colour = await colourFraction(pages[0].file);

  // 3. profile + title block from page 1 (model call)
  const p1 = pages[0];
  const overview = await cropForModel(p1.file, { x: 0, y: 0, w: p1.W, h: p1.H });
  const tbRegion = { x: p1.W * 0.55, y: p1.H * 0.6, w: p1.W * 0.45, h: p1.H * 0.4 };
  const tb = await cropForModel(p1.file, tbRegion);
  const reply = await callJSON<ProfileReply>(ctx, {
    stage: "locate",
    label: "profile + title block",
    system: systemPrompt(ctx.settings, ctx.settings.standard),
    prompt: PROFILE_PROMPT,
    images: [
      { data: overview.data, mediaType: "image/png", caption: "Image 1 — whole sheet:" },
      { data: tb.data, mediaType: "image/png", caption: "Image 2 — bottom-right area (title block):" },
    ],
    schema: PROFILE_SCHEMA,
    effort: ctx.settings.effort,
    maxTokens: 16000,
  });

  const standard = ctx.settings.standard === "auto" ? reply.standard : ctx.settings.standard;
  const profile: Profile = {
    file: path.basename(staged),
    bytes,
    pages: pages.length,
    page_size_pt: info.size,
    rotation: info.rotation,
    has_text_layer: hasText,
    color: colour > 0.002,
    dpi,
    pages_px: pages.map((p) => [p.W, p.H]),
    standard_detected: reply.standard,
    standard_cues: reply.standard_cues,
    notes: [
      ...(hasText ? [] : ["Scanned sheet without a text layer — everything is read visually."]),
      ...(colour > 0.002 ? [`Colour drawing (${(colour * 100).toFixed(1)}% coloured pixels) — colours may carry meaning.`] : []),
      ...(reply.is_pid ? [] : ["The model doubts this is a P&ID."]),
      ...reply.notes,
    ],
  };
  if (ctx.settings.standard !== "auto") profile.notes.push(`Standard pinned to '${ctx.settings.standard}' by the caller; detection said '${reply.standard}'.`);
  ctx.writeJSON("drawing.profile.json", profile);
  ctx.bag.pages = pages;
  ctx.bag.titleBlock = reply.title_block;
  ctx.bag.standard = standard;
  ctx.bag.profile = profile;
  ctx.log("locate", `Title block: ${reply.title_block.drawing_number ?? "?"} — ${reply.title_block.title ?? "?"} rev ${reply.title_block.revision ?? "?"}; standard ${standard}`);
  return profile;
}
