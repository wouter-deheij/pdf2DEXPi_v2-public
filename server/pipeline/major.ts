import { callJSON } from "../llm.ts";
import { FatalApiError } from "../llm.ts";
import type { BBox, Item } from "../types.ts";
import type { RunContext } from "./context.ts";
import { backProject, cropForModel } from "./images.ts";
import type { PageImage } from "./locate.ts";
import { assignIds, family, normTag } from "./merge.ts";
import { DEXPI_EQUIPMENT } from "./prompts.ts";

/**
 * Overview pass for large equipment.
 *
 * A fermenter, tank or column on an A1/A2 sheet is larger than one 1400 px tile, so every tile
 * only sees a cut-off piece of it (untagged, "cut_at_edge") and the merge cannot rebuild the whole
 * symbol. One look at the whole sheet does see it whole; its box replaces the pieces.
 */

export interface MajorItem {
  tag: string | null;
  type: string;
  dexpi_class: string | null;
  description: string | null;
  service: string | null;
  bbox: number[];
  confidence: number;
}
interface MajorReply {
  equipment: MajorItem[];
}

const MAJOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["equipment"],
  properties: {
    equipment: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "type", "dexpi_class", "description", "service", "bbox", "confidence"],
        properties: {
          tag: { type: ["string", "null"], description: "Tag exactly as printed next to/inside the symbol, or null" },
          type: { type: "string", description: "snake_case, e.g. fermenter, tank, vessel, column, plate_heat_exchanger" },
          dexpi_class: { anyOf: [{ type: "null" }, { type: "string", enum: [...DEXPI_EQUIPMENT] }] },
          description: { type: ["string", "null"], description: "Name/capacity text printed with it (e.g. 'DETERGENT TANK (HOT) 50HL')" },
          service: { type: ["string", "null"] },
          bbox: { type: "array", items: { type: "number" }, description: "[x0,y0,x1,y1] 0–1000 normalised: the WHOLE outline of the symbol (shell + heads, jacket included; not the pipes, nozzles or instruments around it)" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const PROMPT = `This is a whole P&ID sheet, scaled down. List only the LARGE process equipment drawn on it: vessels, tanks, fermenters/bioreactors, reactors, columns, large heat exchangers, filters/housings and containers that are big compared to valves and instrument bubbles.

For each one give the box of its whole outline. A vessel with a top- or side-mounted agitator: list the agitator as its OWN entry (type agitator), its box covering motor/gearbox, shaft and impellers together; the vessel's box is the shell only.
Skip pumps, valves, instruments, small bottles/sample pots, the title block, legend and frames. Equipment without a printed tag is still equipment (tag null). Return JSON only.`;

export async function readMajorEquipment(ctx: RunContext, pages: PageImage[], system: string) {
  const out: (MajorItem & { page: number; box: BBox })[] = [];
  for (const p of pages) {
    const region = { x: 0, y: 0, w: p.W, h: p.H };
    const img = await cropForModel(p.file, region);
    try {
      const r = await callJSON<MajorReply>(ctx, {
        stage: "digitize",
        label: `overview p${p.n} (large equipment)`,
        system,
        prompt: PROMPT,
        images: [{ data: img.data, mediaType: "image/png" }],
        schema: MAJOR_SCHEMA,
        effort: ctx.settings.effort,
      });
      ctx.writeJSON(`work/major_p${p.n}.json`, r);
      for (const e of r.equipment) {
        const box = backProject(e.bbox, region);
        // too small to be cut by a tile → the tiles see it whole; ignore
        if (Math.max(box[2] - box[0], box[3] - box[1]) < 0.04 * Math.max(p.W, p.H)) continue;
        out.push({ ...e, page: p.n, box });
      }
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      ctx.log("digitize", `overview p${p.n} failed: ${(e as Error).message}`);
    }
  }
  return out;
}

const area = (b: BBox) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
function overlap(a: BBox, b: BBox) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return ix * iy;
}

/**
 * Put the overview's large equipment into the merged item list:
 *  - same tag → keep the item, but take the overview box when the item's box is a fragment of it;
 *  - untagged → untagged equipment pieces lying inside it are the same vessel: the best piece
 *    becomes the vessel (overview box), the other pieces are dropped;
 *  - nothing matches → add it.
 * Returns a short log line.
 */
export function reconcileMajor(items: Item[], major: (MajorItem & { page: number; box: BBox })[]) {
  let added = 0, resized = 0, absorbed = 0;
  const drop = new Set<Item>();
  const fresh: Item[] = [];
  for (const m of major) {
    const nt = normTag(m.tag);
    const same = nt ? items.find((i) => i.page === m.page && normTag(i.tag) === nt) : undefined;
    if (same) {
      if (same.category === "equipment" && area(same.bbox) < 0.5 * area(m.box) && overlap(same.bbox, m.box) > 0.5 * area(same.bbox)) {
        same.bbox = m.box;
        same.note = [same.note, "box from the whole-sheet overview (tiles saw only part of it)"].filter(Boolean).join("; ");
        resized++;
      }
      continue;
    }
    // untagged pieces of equipment inside the overview box
    // pieces: mostly inside the box, or the same kind of thing, much smaller and touching the box
    // (a tile that saw only the top of a fermenter still calls it "fermenter")
    const reach = 0.15 * Math.max(m.box[2] - m.box[0], m.box[3] - m.box[1]);
    const grown: BBox = [m.box[0] - reach, m.box[1] - reach, m.box[2] + reach, m.box[3] + reach];
    // a vessel never swallows its agitator and an agitator never swallows its vessel
    const clash = (a: string, b: string) => (a === "vessel" && b === "agitator") || (a === "agitator" && b === "vessel");
    const fm = family(m.type);
    const pieces = items.filter(
      (i) =>
        i.page === m.page && i.category === "equipment" && !normTag(i.tag) && !drop.has(i) && !clash(fm, family(i.type)) &&
        ((overlap(i.bbox, m.box) > 0.6 * area(i.bbox) && area(i.bbox) > 0.03 * area(m.box)) ||
          (family(i.type) === fm && area(i.bbox) < 0.25 * area(m.box) && overlap(i.bbox, grown) > 0)),
    );
    if (!nt && pieces.length) {
      const best = pieces.sort((a, b) => overlap(b.bbox, m.box) - overlap(a.bbox, m.box))[0];
      Object.assign(best, {
        type: m.type,
        dexpi_class: m.dexpi_class ?? best.dexpi_class,
        description: m.description ?? best.description,
        service: m.service ?? best.service,
        bbox: m.box,
        confidence: Number(Math.max(best.confidence, m.confidence).toFixed(2)),
        note: [best.note, "whole outline from the sheet overview"].filter(Boolean).join("; "),
      });
      best.sources = [...new Set([...best.sources, ...pieces.flatMap((p) => p.sources), `overview-p${m.page}`])];
      for (const p of pieces) if (p !== best) drop.add(p);
      absorbed += pieces.length - 1;
      resized++;
      continue;
    }
    // already known as an untagged item of about this size and place?
    if (!nt && items.some((i) => i.page === m.page && i.category === "equipment" && !clash(fm, family(i.type)) && overlap(i.bbox, m.box) > 0.5 * Math.min(area(i.bbox), area(m.box)) && area(i.bbox) > 0.5 * area(m.box))) continue;
    fresh.push({
      id: "",
      page: m.page,
      tag: m.tag,
      category: "equipment",
      type: m.type,
      dexpi_class: m.dexpi_class,
      description: m.description,
      service: m.service,
      size: null,
      line_ref: null,
      actuator: null,
      loop: null,
      color: null,
      bbox: m.box,
      confidence: Number(m.confidence.toFixed(2)),
      sources: [`overview-p${m.page}`],
      note: "found on the whole-sheet overview (larger than one tile)",
    });
    added++;
  }
  const kept = items.filter((i) => !drop.has(i));
  if (fresh.length) {
    const taken = new Set(kept.map((i) => i.id));
    assignIds(fresh);
    for (const f of fresh) {
      const base = f.id.replace("-auto-", "-ovw-");
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      f.id = id;
      taken.add(id);
    }
  }
  items.splice(0, items.length, ...kept, ...fresh);
  return `overview: ${major.length} large equipment; ${added} added, ${resized} boxes from the overview, ${absorbed} tile fragments folded in`;
}
