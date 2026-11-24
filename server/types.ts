// Shared types for the pipeline, the API and the React UI (type-only imports in the UI).

export type Standard = "auto" | "american" | "german" | "iso" | "dutch" | "british" | "french";
export type Depth = "fast" | "verified" | "exhaustive";
export type TagLanguage = "as-printed" | "transliterate";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunSettings {
  standard: Standard;
  depth: Depth;
  tag_language: TagLanguage;
  /** Effort for the bulk tile reads; audit/connect run one level higher. */
  effort: Effort;
  /** A second reading: what checking the earlier run found (open points, overlay, the engineer's notes). */
  guidance?: string;
}

export const DEFAULT_SETTINGS: RunSettings = {
  standard: "auto",
  depth: "verified",
  tag_language: "as-printed",
  effort: "medium",
};

export const STAGES = [
  { id: "locate", label: "Locate & profile the drawing", produces: ["drawing.pages", "drawing.profile"] },
  { id: "digitize", label: "Segment → extract → merge to XML", produces: ["drawing.xml"] },
  { id: "verify", label: "Audit the merge against the drawing", produces: ["drawing.verified_xml", "drawing.score"] },
  { id: "connect", label: "Trace lines & connectivity", produces: ["drawing.lines", "drawing.signals"] },
  { id: "tabulate", label: "Land tables & databases", produces: ["drawing.tables", "pid.sqlite"] },
  { id: "dexpi", label: "Generate DEXPI model + drawing", produces: ["drawing.dexpi.xml", "drawing.dexpi.svg"] },
  { id: "report", label: "Report the declared answer", produces: ["drawing.answer"] },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type Category = "equipment" | "instrument" | "valve" | "piping_component" | "off_page";

export type BBox = [number, number, number, number]; // x0,y0,x1,y1 in full-page pixels

export interface Item {
  id: string; // stable id inside the project (tag based where possible)
  page: number; // 1-based sheet
  tag: string | null; // exactly as printed
  category: Category;
  type: string; // e.g. tank, centrifugal_pump, ball_valve, PIC
  dexpi_class: string | null; // concrete DEXPI 2.0.1 class chosen from the symbol
  description: string | null;
  service: string | null;
  size: string | null;
  line_ref: string | null;
  actuator: string | null;
  loop: string | null;
  color: string | null;
  bbox: BBox;
  confidence: number;
  sources: string[]; // tile ids / audit rounds that saw it
  note?: string;
  /** the tag's label frame, when the box was read on the label and moved along its leader to the symbol */
  label_box?: BBox;
}

export interface Line {
  id: string;
  page: number;
  line_id: string | null; // printed line number, if any
  size: string | null;
  spec: string | null;
  service: string | null;
  from: Endpoint;
  to: Endpoint;
  components: string[]; // item ids in flow order
  insulation: string | null;
  confidence: number;
}

/** Where a pipe run starts or ends. kind=line → branch (tee) on another run, after component `after`. */
export interface Endpoint {
  kind: "equipment" | "off_page" | "line" | "open";
  ref: string | null; // item id, or line id for kind=line
  after: string | null; // for kind=line: component id after which the branch sits (null = start)
  /** for kind=line: where the branch meets the run on the drawing (page px; vector layer) */
  at?: [number, number];
  /** for kind=equipment: the nozzle name printed at that connection (S1, T3, N2 …; vector layer) */
  nozzle?: string;
}

export interface SignalLink {
  instrument: string; // item id of the instrument
  kind: "measures" | "actuates" | "signal";
  target: string; // item id or line id
  /** how the link was found when no line was followed: "loop" = same loop number (inferred) */
  basis?: "loop";
  /** id of the drawn signal line that carries it (vector layer), if one was matched */
  via?: string;
  /** measures: where the drawn impulse / instrument line meets the pipe (page px, vector layer) */
  at?: [number, number];
}

/** ISA 5.1 line types for signal and instrument lines. */
export type SignalLineType = "electrical" | "pneumatic" | "capillary" | "software" | "process_connection" | "unknown";

/**
 * A drawn signal / instrument line taken from the PDF's vector geometry (not read by the model).
 * Ends are the items it reaches, the runs it taps, or loose ends. A bus (an I/O or fieldbus
 * header that many bubbles hang off) is one signal line with many ends.
 */
export interface SignalLine {
  id: string;
  page: number;
  type: SignalLineType;
  pattern: "solid" | "dash" | "dashdot";
  bus: boolean;
  ends: { item?: string; line?: string; at: [number, number] }[];
  path: [number, number][][]; // page px
  length: number; // px
}

/** Exact route of the pipe between two items, from the PDF's vector geometry (page px). */
export interface PipeRoute {
  page: number;
  a: string;
  b: string;
  pts: [number, number][];
}

export interface TitleBlock {
  drawing_number: string | null;
  title: string | null;
  revision: string | null;
  sheet: string | null;
  date: string | null;
  unit: string | null;
  plant: string | null;
  project_number: string | null;
  author: string | null;
  client: string | null;
}

export interface Ambiguity {
  tag: string;
  issue: string;
}

export interface Profile {
  file: string;
  bytes: number;
  pages: number;
  page_size_pt: [number, number];
  rotation: number;
  has_text_layer: boolean;
  color: boolean;
  dpi: number;
  pages_px: [number, number][];
  standard_detected: Exclude<Standard, "auto"> | "unknown";
  standard_cues: string[];
  notes: string[];
}

export interface DrawingModel {
  document: string;
  pages: { n: number; px: [number, number]; image: string }[];
  dpi: number;
  standard: Answer["standard"];
  title_block: TitleBlock;
  items: Item[];
  lines: Line[];
  signals: SignalLink[];
  ambiguities: Ambiguity[];
  comments: string[];
  /** vector layer (CAD PDFs only): drawn signal lines and exact pipe routes */
  signal_lines?: SignalLine[];
  pipe_routes?: PipeRoute[];
}

export interface Answer {
  drawing_number: string | null;
  drawing_title: string | null;
  revision: string | null;
  sheet: string | null;
  standard: "american" | "german" | "iso" | "dutch" | "british" | "french" | "unknown";
  unit: string | null;
  equipment_count: number;
  instrument_count: number;
  valve_count: number;
  line_count: number;
  confidence: number;
  unresolved: Ambiguity[];
}

export interface Usage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface StageState {
  id: StageId;
  status: StageStatus;
  started_at?: string;
  finished_at?: string;
  note?: string;
}

export interface RunState {
  project: string;
  source: string;
  settings: RunSettings;
  model: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  stages: StageState[];
  log: { t: string; stage: StageId | "run"; msg: string }[];
  usage: Usage;
  score?: number;
  error?: string;
  /** process that runs it (server or CLI); a dead pid with status running = interrupted */
  pid?: number;
  /** number of this run (kept under runs/run-<n>/) */
  run_no?: number;
  /** a re-run made from an earlier run with its open points, overlay and the engineer's notes */
  rerun?: {
    from: number | null;
    notes: string;
    open_points: number;
    overlay_points: number;
    /** full: the drawing read again with hints; correction: the earlier reading kept, only its doubtful spots looked at again */
    kind?: "full" | "correction";
    /** correction: made active because it is at least as good as the run it started from */
    accepted?: boolean;
    verdict?: string;
  };
}

export interface ProjectSummary {
  project: string;
  source: string;
  status: RunState["status"] | "unknown";
  started_at?: string;
  answer?: Answer;
  usage?: Usage;
}
