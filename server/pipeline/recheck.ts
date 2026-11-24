import sharp from "sharp";
import { callJSON } from "../llm.ts";
import { FatalApiError } from "../llm.ts";
import type { BBox, DrawingModel, Item } from "../types.ts";
import type { RunContext } from "./context.ts";
import { backProject, cropForModel, type Region } from "./images.ts";
import { itemProps } from "./prompts.ts";
import type { Finding } from "./verify.ts";

/**
 * Second look for uncertain audit findings (confidence < 0.6).
 *
 * The audit sees a 1900 px block at about 0.8× scale, where a valve, a reducer and a line-end
 * arrow look alike. Each uncertain finding gets one small call on a crop around just that spot,
 * at 2–3× the audit's resolution, with the item in question outlined. The answer is confirm /
 * reject / unsure: confirmed findings are applied, rejected ones dropped, unsure ones stay open.
 */

export interface Deferred {
  f: Finding;
  r: Region;
}

interface RecheckReply {
  verdict: "confirm" | "reject" | "unsure";
  confidence: number;
  reason: string;
  corrected: (Omit<Item, "id" | "page" | "loop" | "sources" | "bbox"> & { bbox: number[] }) | null;
}

const RECHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason", "corrected"],
  properties: {
    verdict: { type: "string", enum: ["confirm", "reject", "unsure"] },
    confidence: { type: "number", description: "0–1 confidence in the verdict" },
    reason: { type: "string", description: "One sentence: what the zoomed image shows" },
    corrected: {
      anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: Object.keys(itemProps), properties: itemProps }],
      description: "Only when confirming a change, a missing symbol or a box position: the item as it should be, bbox relative to THIS image (0–1000). Null otherwise.",
    },
  },
};

/** At or above this verdict confidence a confirm/reject is acted on; below it the finding stays open. */
const DECIDE = 0.7;

export const ambiguityOf = ({ f, r }: Deferred) => ({
  tag: f.item_id ?? f.proposed?.tag ?? `region ${r.id}`,
  issue: `${f.issue} (audit confidence ${f.confidence.toFixed(2)})`,
});

const describe = (i: Item) =>
  [`category=${i.category}`, `type=${i.type}`, `tag=${i.tag ?? "—"}`, i.dexpi_class && `class=${i.dexpi_class}`, i.actuator && `actuator=${i.actuator}`, i.size && `size=${i.size}`]
    .filter(Boolean)
    .join(", ");

const describeProposed = (p: NonNullable<Finding["proposed"]>) =>
  [`category=${p.category}`, `type=${p.type}`, `tag=${p.tag ?? "—"}`, p.dexpi_class && `class=${p.dexpi_class}`, p.actuator && `actuator=${p.actuator}`].filter(Boolean).join(", ");

export async function recheckFindings(ctx: RunContext, model: DrawingModel, list: Deferred[], system: string) {
  const confirmed: Deferred[] = [], rejected: Deferred[] = [], unsure: Deferred[] = [];
  const pageFile = (n: number) => ctx.path("pages", `page-${n}.png`);
  await Promise.all(
    list.map(async (d, k) => {
      const { f, r } = d;
      const target = f.item_id ? model.items.find((i) => i.id === f.item_id) : undefined;
      if (f.item_id && !target) return; // item gone since (merged / removed): nothing left to decide
      const proposedBox = f.proposed?.bbox?.length === 4 ? backProject(f.proposed.bbox, r) : null;
      const boxes = [target?.bbox, proposedBox].filter(Boolean) as BBox[];
      if (!boxes.length) {
        unsure.push(d); // a region-level remark without a place: leave it for a person
        return;
      }
      const page = model.pages.find((p) => p.n === r.page)!;
      const [W, H] = page.px;
      const fx0 = Math.min(...boxes.map((b) => b[0])), fy0 = Math.min(...boxes.map((b) => b[1]));
      const fx1 = Math.max(...boxes.map((b) => b[2])), fy1 = Math.max(...boxes.map((b) => b[3]));
      // enough context to see the pipe it sits on, small enough to zoom in
      const side = Math.min(Math.max(W, H), Math.max(520, 3 * Math.max(fx1 - fx0, fy1 - fy0)));
      const x = Math.round(Math.min(Math.max(0, (fx0 + fx1) / 2 - side / 2), Math.max(0, W - side)));
      const y = Math.round(Math.min(Math.max(0, (fy0 + fy1) / 2 - side / 2), Math.max(0, H - side)));
      const crop: Region = { id: `${r.id}_k${k}`, page: r.page, x, y, w: Math.min(side, W - x), h: Math.min(side, H - y) };
      const img = await cropForModel(pageFile(r.page), crop, 1000);
      // outline the item in question (magenta, dashed) so the question is unambiguous
      const iw = Math.round(crop.w * img.scale), ih = Math.round(crop.h * img.scale);
      const rect = (b: BBox, colour: string) => {
        const [a0, b0, a1, b1] = [(b[0] - x) * img.scale, (b[1] - y) * img.scale, (b[2] - x) * img.scale, (b[3] - y) * img.scale].map((v) => Math.round(v));
        return `<rect x="${a0 - 4}" y="${b0 - 4}" width="${a1 - a0 + 8}" height="${b1 - b0 + 8}" fill="none" stroke="${colour}" stroke-width="3" stroke-dasharray="10 6"/>`;
      };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}">${target ? rect(target.bbox, "#e0109a") : ""}${proposedBox && f.kind === "missing" ? rect(proposedBox, "#1060e0") : ""}</svg>`;
      const data = await sharp(img.data).composite([{ input: Buffer.from(svg) }]).png().toBuffer();

      const claim =
        f.kind === "missing"
          ? `A symbol is drawn here that the item list does not contain (blue dashed outline marks where): ${f.proposed ? describeProposed(f.proposed) : "?"}.`
          : `The item outlined in magenta is currently read as: ${target ? describe(target) : "?"}.`;
      try {
        const reply = await callJSON<RecheckReply>(ctx, {
          stage: "verify",
          label: `recheck ${f.kind} ${f.item_id ?? r.id}`,
          system,
          prompt: `Zoomed crop of a P&ID sheet. ${claim}
A first audit at lower resolution made this claim (${f.kind}), but was unsure: "${f.issue}"${f.proposed && f.kind !== "missing" ? `\nIt proposed: ${describeProposed(f.proposed)}.` : ""}

Look closely at the outlined spot and decide:
- confirm: the claim is right;
- reject: the current reading is right and the claim is wrong;
- unsure: the image does not settle it.
When you confirm a missing symbol, a changed reading or a moved box, give the item as it should be in 'corrected' (bbox 0–1000 relative to this image). Otherwise corrected = null. Return JSON only.`,
          images: [{ data, mediaType: "image/png" }],
          schema: RECHECK_SCHEMA,
          effort: ctx.settings.effort,
          maxTokens: 16000,
        });
        if (reply.verdict === "confirm" && reply.confidence >= DECIDE) {
          // the corrected item is relative to the crop; without one, keep the audit's own proposal
          const fixed: Finding = { ...f, confidence: reply.confidence, issue: `${f.issue} — zoom: ${reply.reason}`, proposed: reply.corrected ?? f.proposed };
          confirmed.push({ f: fixed, r: reply.corrected ? crop : r });
        } else if (reply.verdict === "reject" && reply.confidence >= DECIDE) rejected.push(d);
        else unsure.push({ f: { ...f, issue: `${f.issue} — zoom: ${reply.reason}` }, r });
      } catch (e) {
        if (e instanceof FatalApiError) throw e;
        ctx.log("verify", `recheck ${f.item_id ?? r.id} failed: ${(e as Error).message}`);
        unsure.push(d);
      }
    }),
  );
  return { confirmed, rejected, unsure };
}

