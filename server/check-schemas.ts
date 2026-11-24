import Anthropic from "@anthropic-ai/sdk";
import { TILE_SCHEMA, CONNECT_SCHEMA, AUDIT_SCHEMA, PROFILE_SCHEMA } from "./pipeline/prompts.ts";
const c = new Anthropic();
for (const [n, schema] of Object.entries({ TILE_SCHEMA, CONNECT_SCHEMA, AUDIT_SCHEMA, PROFILE_SCHEMA })) {
  try {
    const m = await c.beta.messages.create({ model: "claude-opus-5-5", max_tokens: 2000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: "Return an empty/minimal valid object." }] });
    console.log(n, "OK", m.stop_reason, (m.content.find(b=>b.type==="text") as any)?.text?.slice(0,120));
  } catch (e: any) { console.log(n, "ERR", e.status, e.message?.slice(0, 400)); }
}
