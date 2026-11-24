import type { Answer, DrawingModel, Profile } from "../types.ts";
import type { RunContext } from "./context.ts";
import type { Tables } from "./tabulate.ts";

/** Fill the declared answer shape (Corvic 'P&ID Read') and write a human-readable report. */
export function report(ctx: RunContext) {
  const model = ctx.bag.model as DrawingModel;
  const tables = ctx.bag.tables as Tables;
  const profile = ctx.bag.profile as Profile;
  const tb = model.title_block;
  const score = (ctx.bag.score as number) ?? 0;

  // a single-sheet drawing often has no sheet number: that is not an open point
  const missing = (["drawing_number", "title", "revision", "unit"] as const).filter((k) => !tb[k]);
  const unresolved = [
    ...model.ambiguities,
    ...missing.map((k) => ({ tag: "Title block", issue: `'${k}' is not printed on the sheet (or not legible); left null.` })),
  ];

  const answer: Answer = {
    drawing_number: tb.drawing_number,
    drawing_title: tb.title,
    revision: tb.revision,
    sheet: tb.sheet,
    standard: model.standard,
    unit: tb.unit,
    equipment_count: tables.equipment.length,
    instrument_count: tables.instruments.length,
    valve_count: tables.valves.length,
    line_count: tables.lines.length,
    confidence: score,
    unresolved,
  };
  ctx.writeJSON("drawing.answer.json", answer);

  const warnings = (ctx.bag.dexpiWarnings as string[]) ?? [];
  const u = ctx.state.usage;
  const md = `# ${tb.drawing_number ?? ctx.state.project} — ${tb.title ?? "(untitled)"}

> Digitalisering voor early engineering, gemaakt door een vision-model. **Geen ontwerpvrijgave**: de verantwoordelijke engineer controleert altijd tegen de bron-PDF.

| veld | waarde |
|---|---|
| bron | \`${model.document}\` (${profile.pages} pagina('s), ${profile.has_text_layer ? "met" : "zonder"} tekstlaag, ${profile.color ? "kleur" : "zwart-wit"}) |
| tekeningnummer | ${tb.drawing_number ?? "—"} |
| titel | ${tb.title ?? "—"} |
| revisie | ${tb.revision ?? "—"} |
| blad | ${tb.sheet ?? "—"} |
| unit | ${tb.unit ?? "—"} |
| plant / opdrachtgever | ${[tb.plant, tb.client].filter(Boolean).join(" / ") || "—"} |
| symboolnorm | ${model.standard} |
| audit-score (confidence) | ${score} (${ctx.settings.depth}) |

## Aantallen

| lijst | aantal |
|---|---|
${Object.entries(tables).filter(([k]) => k !== "drawing").map(([k, v]) => `| ${k} | ${v.length} |`).join("\n")}

## Open punten (${unresolved.length})

${unresolved.map((a) => `- **${a.tag}** — ${a.issue}`).join("\n") || "_geen_"}

## DEXPI-waarschuwingen (${warnings.length})

${warnings.map((w) => `- ${w}`).join("\n") || "_geen_"}

## Profiel

${profile.notes.map((n) => `- ${n}`).join("\n")}
${profile.standard_cues.length ? `- Norm-aanwijzingen: ${profile.standard_cues.join("; ")}` : ""}

## Kosten

${u.calls} model-calls (${ctx.state.model}), ${u.input_tokens.toLocaleString("nl-NL")} input + ${u.output_tokens.toLocaleString("nl-NL")} output tokens ≈ $${u.cost_usd.toFixed(2)}.
`;
  ctx.writeText("report.md", md);
  ctx.log("report", `answer: ${answer.equipment_count} equipment, ${answer.instrument_count} instruments, ${answer.valve_count} valves, ${answer.line_count} lines, confidence ${score}, ${unresolved.length} unresolved`);
  return answer;
}
