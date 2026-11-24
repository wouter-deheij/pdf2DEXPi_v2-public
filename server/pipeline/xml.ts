import type { DrawingModel, Endpoint, Item } from "../types.ts";
import type { RunContext } from "./context.ts";

export function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attrs(o: Record<string, unknown>) {
  return Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${esc(Array.isArray(v) ? JSON.stringify(v) : v)}"`)
    .join(" ");
}

function itemXml(i: Item) {
  return `    <Item ${attrs({
    id: i.id,
    tag: i.tag,
    page: i.page,
    type: i.type,
    dexpi_class: i.dexpi_class,
    description: i.description,
    service: i.service,
    size: i.size,
    line: i.line_ref,
    actuator: i.actuator,
    loop: i.loop,
    color: i.color,
    confidence: i.confidence,
    bbox: i.bbox,
    sources: i.sources.join(" "),
  })}/>${i.note ? ` <!-- ${esc(i.note).replace(/--/g, "–")} -->` : ""}`;
}

const ep = (e: Endpoint) => (e.kind === "line" ? `line:${e.ref ?? "?"}${e.after ? `@${e.after}` : ""}` : `${e.kind}:${e.ref ?? ""}`);

/** The Corvic-style page XML: title block, the four lists, lines and ambiguities. */
export function drawingXml(m: DrawingModel) {
  const group = (tag: string, cat: Item["category"]) => {
    const list = m.items.filter((i) => i.category === cat);
    return `  <${tag} count="${list.length}">\n${list.map(itemXml).join("\n")}\n  </${tag}>`;
  };
  const tb = m.title_block;
  return `<?xml version="1.0" encoding="UTF-8"?>
<PID ${attrs({ document: m.document, pages: m.pages.length, dpi: m.dpi, standard: m.standard, page_px: m.pages.map((p) => p.px.join("x")).join(",") })}>
${m.comments.map((c) => `  <!-- ${esc(c).replace(/--/g, "–")} -->`).join("\n")}
  <TitleBlock ${attrs({ drawing_number: tb.drawing_number, title: tb.title, revision: tb.revision, sheet: tb.sheet, date: tb.date, unit: tb.unit, plant: tb.plant, project_number: tb.project_number, author: tb.author, client: tb.client })}/>
${group("Equipment", "equipment")}
${group("Instruments", "instrument")}
${group("Valves", "valve")}
${group("PipingComponents", "piping_component")}
${group("OffPageConnectors", "off_page")}
  <Lines count="${m.lines.length}">
${m.lines.map((l) => `    <Line ${attrs({ id: l.id, line_id: l.line_id, page: l.page, size: l.size, spec: l.spec, service: l.service, from: ep(l.from), to: ep(l.to), components: l.components.join(" "), insulation: l.insulation, confidence: l.confidence })}/>`).join("\n")}
  </Lines>
  <Signals count="${m.signals.length}">
${m.signals.map((s) => `    <Signal ${attrs(s as unknown as Record<string, unknown>)}/>`).join("\n")}
  </Signals>
  <Ambiguities count="${m.ambiguities.length}">
${m.ambiguities.map((a) => `    <Ambiguity ${attrs({ tag: a.tag, issue: a.issue })}/>`).join("\n")}
  </Ambiguities>
</PID>
`;
}

export function writeDrawingXml(ctx: RunContext, m: DrawingModel, rel: string) {
  ctx.writeText(rel, drawingXml(m));
}
