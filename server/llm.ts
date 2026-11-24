import Anthropic from "@anthropic-ai/sdk";
import { CONCURRENCY, MODEL, PRICES } from "./config.ts";
import type { Effort, StageId } from "./types.ts";
import type { RunContext } from "./pipeline/context.ts";

const client = new Anthropic({ maxRetries: 4, timeout: 20 * 60 * 1000 });

export interface ImageInput {
  data: Buffer;
  mediaType: "image/png" | "image/jpeg";
  caption?: string;
}

export interface JSONCall {
  stage: StageId;
  label: string;
  system: string;
  prompt: string;
  images: ImageInput[];
  schema: Record<string, unknown>;
  effort: Effort;
  maxTokens?: number;
}

/** Tiny promise pool so tile reads run in parallel without flooding the API. */
let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export class ModelError extends Error {}

/**
 * An error no retry or other tile will get past (no credit, bad key, no access): the run must
 * stop instead of carrying on with failed tiles and audits, which would look like a finished
 * but thin result.
 */
export class FatalApiError extends Error {}
export function asFatal(e: unknown): FatalApiError | null {
  if (e instanceof FatalApiError) return e;
  const err = e as { status?: number; message?: string };
  const msg = String(err?.message ?? e);
  if (err?.status === 401 || err?.status === 403 || /credit balance is too low|billing|invalid x-api-key|authentication_error|permission_error/i.test(msg)) {
    const why = /credit balance/i.test(msg) ? "API credit is used up (Plans & Billing)" : err?.status === 401 ? "API key rejected" : "no access to the API";
    return new FatalApiError(`${why} — run stopped. Top up / fix the key and start it again.`);
  }
  return null;
}

/**
 * One vision call that must come back as JSON matching `schema` (structured outputs).
 * Uses the server-side refusal fallback so a classifier false-positive on a drawing
 * does not kill the run.
 */
export async function callJSON<T>(ctx: RunContext, call: JSONCall): Promise<T> {
  return slot(async () => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of call.images) {
      if (img.caption) content.push({ type: "text", text: img.caption });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") },
      });
    }
    content.push({ type: "text", text: call.prompt });

    const t0 = Date.now();
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: call.maxTokens ?? 48000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: call.effort, format: { type: "json_schema", schema: call.schema } },
      system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    let msg: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      throw asFatal(e) ?? e;
    }

    // usage + cost
    const u = msg.usage;
    const price = PRICES[MODEL] ?? PRICES["claude-opus-5-5"];
    const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const usage = ctx.state.usage;
    usage.calls++;
    usage.input_tokens += inTok;
    usage.cache_read_tokens += cacheRead;
    usage.output_tokens += u.output_tokens;
    usage.cost_usd += (inTok * price.in + cacheRead * price.cacheRead + u.output_tokens * price.out) / 1e6;

    if (msg.stop_reason === "refusal") {
      throw new ModelError(`${call.label}: model declined (${msg.stop_details?.category ?? "no category"})`);
    }
    if (msg.stop_reason === "max_tokens") {
      throw new ModelError(`${call.label}: output hit max_tokens`);
    }
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    ctx.log(call.stage, `${call.label} ✓ (${((Date.now() - t0) / 1000).toFixed(0)}s, ${u.output_tokens} out-tokens)`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ModelError(`${call.label}: response was not valid JSON`);
    }
  });
}

/** Effort one step up from the bulk setting, for the judgement-heavy calls. */
export function stepUp(e: Effort): Effort {
  const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  return order[Math.min(order.indexOf(e) + 1, order.length - 1)];
}
