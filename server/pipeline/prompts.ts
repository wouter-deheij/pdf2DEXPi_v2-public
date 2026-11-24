import type { RunSettings } from "../types.ts";

const STANDARD_TEXT: Record<string, string> = {
  american: "American ISA S5.1 / ANSI symbols",
  german: "German DIN 19227 / DIN 2481 symbols",
  iso: "ISO 10628 / ISO 14617 symbols",
  dutch: "Dutch NEN symbols",
  british: "British BS 1646 / BS 5070 symbols",
  french: "French NF E 04-203 symbols",
};

export function systemPrompt(s: RunSettings, standard: string) {
  const std =
    standard === "auto" || standard === "unknown"
      ? "The symbol standard is not settled; read symbols by their shape and say which convention the cues suggest."
      : `Read every symbol against the ${STANDARD_TEXT[standard] ?? standard} convention.`;
  const lang =
    s.tag_language === "as-printed"
      ? "Keep every tag, label and line id exactly as printed (same characters, same script)."
      : "Transliterate non-Latin tag text to Latin script; keep digits and separators.";
  return `You are a senior P&ID digitization engineer. You read engineering drawings with the precision of a certified process engineer and the skepticism of a QA auditor.

Ground rules:
- Never invent. Nothing goes in the answer unless it is visible on the image. An empty list is a correct answer; a plausible one is not.
- ${lang} Remove only line breaks inside a tag bubble: a bubble showing "PIC" over "801" is the tag "PIC801" — but when the top line itself ends in a digit (e.g. "LE1" over "6901", "WE3" over "6905"), keep the break as a hyphen: "LE1-6901". Keep printed spaces and hyphens otherwise.
- Confidence is honest: 0.95 = clearly legible, 0.7 = partly legible, 0.5 = genuinely uncertain.
- ${std}
- Coordinates are boxes [x0, y0, x1, y1] normalised 0–1000 relative to the image you are given (0,0 = top-left).

Category definitions:
- equipment: vessels, tanks, columns, reactors/fermenters, pumps, compressors, blowers, heat exchangers, heaters, filters, agitators, mixers, separators, dosing pumps.
- instrument: ISA-style bubbles/balloons and instrument functions (PT, TIC, LSH, FI, analyzers…), incl. control valves' controllers. NOT the valve body itself.
- valve: any valve body (manual, control, on/off, check, safety/relief, solenoid, pinch, diaphragm, butterfly, ball…). Hand valves (HV) and actuated valves (XV, CV, PCV, FCV) are valves.
- piping_component: in-line items that are not valves: steam traps, flexible hoses, strainers, sight glasses, spool pieces, reducers, flow meters' bodies, nozzles with tags, spray balls, rupture discs (use type to say which).
- off_page: off-page / battery-limit connectors and utility boxes (e.g. "STEAM SUPPLY", "TO DRAIN", "CIP RETURN").

Use snake_case English for 'type' (e.g. tank, fermenter, centrifugal_pump, peristaltic_pump, plate_heat_exchanger, shell_tube_heat_exchanger, filter, ball_valve, butterfly_valve, diaphragm_valve, check_valve, globe_valve, gate_valve, needle_valve, safety_valve, solenoid_valve, control_valve, pressure_regulator, steam_trap, flexible_hose, sight_glass, spray_ball). For instruments, 'type' is the function letters (e.g. PIC, TT, LSH).${s.guidance ? `\n\n## Second reading\n${s.guidance}` : ""}`;
}

const nullableString = { type: ["string", "null"] };
const bbox = { type: "array", items: { type: "number" }, description: "[x0,y0,x1,y1] 0–1000 normalised" };
const category = { type: "string", enum: ["equipment", "instrument", "valve", "piping_component", "off_page"] };

/** Concrete DEXPI 2.0.1 classes the model may choose from (ProcessEquipment.* and Piping.*). */
export const DEXPI_EQUIPMENT = [
  "Tank", "Vessel", "PressureVessel", "ProcessColumn", "Silo", "TransportableContainer",
  "CentrifugalPump", "ReciprocatingPump", "RotaryPump", "EjectorPump", "Pump",
  "CentrifugalCompressor", "ReciprocatingCompressor", "RotaryCompressor", "Compressor", "Blower", "Fan",
  "PlateHeatExchanger", "TubularHeatExchanger", "SpiralHeatExchanger", "HeatExchanger", "ElectricHeater", "Heater", "Boiler", "SteamGenerator", "CoolingTower",
  "Filter", "LiquidFilter", "GasFilter", "Separator", "Centrifuge", "Sieve",
  "Agitator", "Mixer", "StaticMixer", "RotaryMixer", "Dryer", "Weigher", "Conveyor", "Motor",
] as const;
export const DEXPI_PIPING = [
  "BallValve", "ButterflyValve", "GateValve", "GlobeValve", "PlugValve", "NeedleValve", "CheckValve", "SwingCheckValve", "GlobeCheckValve",
  "AngleValve", "AngleBallValve", "AngleGlobeValve", "StraightwayValve", "OperatedValve", "SafetyValveOrFitting",
  "SpringLoadedGlobeSafetyValve", "SpringLoadedAngleGlobeSafetyValve", "BreatherValve", "RuptureDisc",
  "SteamTrap", "Hose", "Strainer", "ConicalStrainer", "SightGlass", "IlluminatedSightGlass", "PipeReducer", "Funnel", "Silencer", "FlameArrestor",
  "RestrictionOrifice", "Compensator", "BlindFlange", "LineBlind", "InLineMixer", "Sensorwell", "VentLine",
  "ElectromagneticFlowMeter", "TurbineFlowMeter", "VariableAreaFlowMeter", "PositiveDisplacementFlowMeter", "MassFlowMeasuringElement", "FlowNozzle", "VenturiTube",
  "FlowInPipeOffPageConnector", "FlowOutPipeOffPageConnector",
] as const;

export const itemProps = {
  tag: { ...nullableString, description: "Tag exactly as printed, or null if the symbol carries no tag" },
  category,
  type: { type: "string" },
  dexpi_class: {
    anyOf: [{ type: "null" }, { type: "string", enum: [...DEXPI_EQUIPMENT, ...DEXPI_PIPING] }],
    description: "Concrete DEXPI 2.0.1 class for equipment/valves/piping components/off-page connectors (null for instruments). Pick the one the symbol shows; an actuated valve (actuator drawn) is OperatedValve.",
  },
  description: nullableString,
  service: { ...nullableString, description: "Fluid/service or function text printed near it" },
  size: { ...nullableString, description: "Nominal size if printed (e.g. 1\", DN25, 12.7x1.65)" },
  line_ref: { ...nullableString, description: "Line id/size label of the pipe it sits on, if legible" },
  actuator: { ...nullableString, description: "manual, pneumatic, electric, solenoid, hydraulic, self-actuated, or null" },
  color: { ...nullableString, description: "Colour if the symbol or its pipe is coloured / highlighted" },
  bbox,
  confidence: { type: "number" },
};

export const TILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "line_labels", "connections", "notes"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...Object.keys(itemProps), "cut_at_edge"],
        properties: { ...itemProps, cut_at_edge: { type: "boolean", description: "true if the symbol is cut off by the image border" } },
      },
    },
    line_labels: {
      type: "array",
      description: "Every printed pipe/line label (line number, size, spec, service) with its position",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "line_id", "size", "spec", "service", "bbox"],
        properties: { text: { type: "string" }, line_id: nullableString, size: nullableString, spec: nullableString, service: nullableString, bbox },
      },
    },
    connections: {
      type: "array",
      description: "Pipe connections fully visible in this image between two tagged things (tags as printed)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "via"],
        properties: { from: { type: "string" }, to: { type: "string" }, via: nullableString },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
};

export function tilePrompt(tileId: string, sheetInfo: string) {
  return `This image is tile ${tileId} of a P&ID sheet (${sheetInfo}). Tiles overlap by ~20%, so items near the border will also appear in a neighbouring tile — still report them, and set cut_at_edge when the symbol is cut off.

List EVERY symbol in this tile: equipment, instruments, valves (tagged or not), in-line piping components and off-page connectors. Untagged valves and fittings matter too — give them tag null. Then list every printed line label, and the pipe connections between tagged things that are fully visible inside this tile.

Do not report title-block text, revision tables, legend symbols or notes as items. Return JSON only.`;
}

export const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title_block", "standard", "standard_cues", "is_pid", "notes", "legend_present"],
  properties: {
    title_block: {
      type: "object",
      additionalProperties: false,
      required: ["drawing_number", "title", "revision", "sheet", "date", "unit", "plant", "project_number", "author", "client"],
      properties: {
        drawing_number: nullableString,
        title: nullableString,
        revision: { ...nullableString, description: "Current (latest) revision as printed" },
        sheet: { ...nullableString, description: "e.g. '2 of 5', only if printed" },
        date: nullableString,
        unit: { ...nullableString, description: "Plant unit / area / system the sheet covers" },
        plant: nullableString,
        project_number: nullableString,
        author: { ...nullableString, description: "Company that drew it" },
        client: nullableString,
      },
    },
    standard: { type: "string", enum: ["american", "german", "iso", "dutch", "british", "french", "unknown"] },
    standard_cues: { type: "array", items: { type: "string" } },
    is_pid: { type: "boolean" },
    legend_present: { type: "boolean" },
    notes: { type: "array", items: { type: "string" }, description: "Anything that changes how the sheet should be read" },
  },
};

export const PROFILE_PROMPT = `Image 1 is the whole P&ID sheet scaled down; image 2 is the title-block area at higher resolution.

1. Read the title block exactly as printed. A field the sheet does not carry is null — never fill it from a nearby field.
2. Decide the symbol convention from cues (title-block language, instrument bubble style, valve and pump symbol shapes, DIN/ISO/ISA markings). Answer 'unknown' if it genuinely cannot be settled; never guess 'american' because it is common.
3. Note anything that changes how the sheet is read (colour coding, highlights, scanned quality, legend present).`;

export const endpoint = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "ref", "after"],
  properties: {
    kind: { type: "string", enum: ["equipment", "off_page", "line", "open"] },
    ref: { ...nullableString, description: "equipment/off-page item id, or the key of another run for kind=line" },
    after: { ...nullableString, description: "kind=line only: id of the component on that run after which this branch joins (null = at its start)" },
  },
};

export const CONNECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "new_items", "instrument_links", "ambiguities"],
  properties: {
    lines: {
      type: "array",
      description: "Pipe runs. A run goes from one end point to another; a branch is a separate run whose start or end is kind=line.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "line_id", "size", "spec", "service", "from", "to", "components", "insulation", "confidence"],
        properties: {
          key: { type: "string", description: "Your own short key for this run: L1, L2, …" },
          line_id: { ...nullableString, description: "Printed line number, null if none is printed" },
          size: nullableString,
          spec: nullableString,
          service: { ...nullableString, description: "Fluid / utility carried" },
          from: endpoint,
          to: endpoint,
          components: { type: "array", items: { type: "string" }, description: "Ids of valves / piping components on this run, in flow order" },
          insulation: nullableString,
          confidence: { type: "number" },
        },
      },
    },
    new_items: {
      type: "array",
      description: "Symbols you trace through or link to that are NOT in the given item list (a valve body, a connector, a second instrument bubble with the same tag). Give each a key N1, N2, … and use that key in runs and links.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "tag", "category", "type", "dexpi_class", "description", "at", "reason"],
        properties: {
          key: { type: "string", description: "N1, N2, …" },
          tag: { ...nullableString, description: "Tag exactly as printed, null if none" },
          category,
          type: { type: "string" },
          dexpi_class: { anyOf: [{ type: "null" }, { type: "string", enum: [...DEXPI_EQUIPMENT, ...DEXPI_PIPING] }] },
          description: nullableString,
          at: { type: "array", items: { type: "number" }, description: "[x,y] centre of the symbol on the 0–1000 grid of the whole sheet" },
          reason: { type: "string", description: "Why it is needed (which run or link)" },
        },
      },
    },
    instrument_links: {
      type: "array",
      description: "measures: instrument → the run key or equipment id it senses; actuates: controller/instrument → the valve id it drives; signal: instrument → instrument",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["instrument", "kind", "target"],
        properties: {
          instrument: { type: "string" },
          kind: { type: "string", enum: ["measures", "actuates", "signal"] },
          target: { type: "string" },
        },
      },
    },
    ambiguities: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["tag", "issue"], properties: { tag: { type: "string" }, issue: { type: "string" } } },
    },
  },
};

export const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "findings"],
  properties: {
    score: { type: "number", description: "0–1: how complete and correct the listed items are for this region" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "item_id", "proposed", "confidence", "issue"],
        properties: {
          kind: { type: "string", enum: ["missing", "hallucinated", "wrong_tag", "wrong_type", "wrong_attribute", "duplicate", "wrong_category", "wrong_position"] },
          item_id: { ...nullableString, description: "id of the listed item this is about (null for missing)" },
          proposed: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: Object.keys(itemProps),
                properties: itemProps,
              },
            ],
            description: "The corrected/added item (bbox relative to this image), null for hallucinated/duplicate",
          },
          confidence: { type: "number" },
          issue: { type: "string", description: "One sentence a person could act on" },
        },
      },
    },
  },
};
