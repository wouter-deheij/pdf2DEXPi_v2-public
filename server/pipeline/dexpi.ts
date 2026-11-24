import type { DrawingModel, Endpoint, Item, Line } from "../types.ts";
import type { RunContext } from "./context.ts";
import { esc } from "./xml.ts";
import { safeId, splitInstrumentTag } from "./merge.ts";
import { DEXPI_EQUIPMENT, DEXPI_PIPING } from "./prompts.ts";

/**
 * DEXPI 2.0.1 writer (Core/Plant XML, same shape as the DrawBite_PDF2DEXPI_v1 builder output).
 * Writes the conceptual model: equipment + nozzles, piping network systems/segments/pipes with
 * tees for branches, off-page connectors, instrumentation functions, loops and actuating systems.
 * The Core/Diagram drawing layer (positions from the PDF) is built in diagram.ts from a trace of this builder.
 */

import { obj, comps, str, mls, ref, nn, render, enumRef, type Node } from "./xmlnode.ts";
import { buildRouter, type PageRouter } from "./router.ts";
import { computeNets, pipeWidth } from "./vectorlayer.ts";
import { buildDiagram, diagramSvg, diagramXml, type DexpiTrace, type TraceElem, type TraceLine } from "./diagram.ts";

// ---------- class mapping ----------
const EQUIP = new Set<string>(DEXPI_EQUIPMENT);
const PIPING = new Set<string>(DEXPI_PIPING);

function equipmentClass(i: Item): string {
  if (i.dexpi_class && EQUIP.has(i.dexpi_class)) return i.dexpi_class;
  const t = `${i.type} ${i.description ?? ""}`.toLowerCase();
  if (/peristaltic|dosing|diaphragm pump|metering/.test(t)) return "RotaryPump";
  if (/centrifugal/.test(t)) return "CentrifugalPump";
  if (/pump/.test(t)) return "Pump";
  if (/plate.*exchanger|phe/.test(t)) return "PlateHeatExchanger";
  if (/exchanger|cooler|condenser/.test(t)) return "HeatExchanger";
  if (/heater/.test(t)) return "Heater";
  if (/filter/.test(t)) return "Filter";
  if (/tank/.test(t)) return "Tank";
  if (/compressor/.test(t)) return "Compressor";
  if (/agitator|stirrer/.test(t)) return "Agitator";
  if (/mixer/.test(t)) return "Mixer";
  if (/container|drum|can|bottle/.test(t)) return "TransportableContainer";
  return "Vessel";
}

function pipingClass(i: Item): string {
  if (i.dexpi_class && PIPING.has(i.dexpi_class) && !/OffPageConnector/.test(i.dexpi_class)) return i.dexpi_class;
  const t = `${i.type}`.toLowerCase();
  const table: [RegExp, string][] = [
    [/ball/, "BallValve"], [/butterfly/, "ButterflyValve"], [/gate/, "GateValve"], [/globe/, "GlobeValve"], [/plug/, "PlugValve"],
    [/needle/, "NeedleValve"], [/check|non.?return/, "CheckValve"], [/safety|relief|psv|prv/, "SafetyValveOrFitting"],
    [/control|solenoid|actuated|on.?off|regulat/, "OperatedValve"], [/steam.?trap/, "SteamTrap"], [/hose|flex/, "Hose"],
    [/strainer|filter/, "Strainer"], [/sight/, "SightGlass"], [/reducer/, "PipeReducer"], [/funnel|tundish/, "Funnel"],
    [/rupture|burst/, "RuptureDisc"], [/orifice/, "RestrictionOrifice"], [/flow.?meter|flowmeter/, "VolumeFlowMeasuringElement"],
  ];
  for (const [re, c] of table) if (re.test(t)) return c;
  return i.category === "valve" ? "StraightwayValve" : "PipeFitting";
}

// ---------- model ----------
/** Piping classes that carry no PipingComponentName/Number attributes in DEXPI 2.0. */
const NO_COMPONENT_NAME = new Set(["BreatherValve", "FlameArrestor", "RuptureDisc", "SafetyValveOrFitting", "SpringLoadedAngleGlobeSafetyValve", "SpringLoadedGlobeSafetyValve", "PropertyBreak"]);

export function buildDexpi(model: DrawingModel, project: string, origin: string, routers?: Map<number, PageRouter>) {
  const inl = instrumentsOffRuns(model);
  const shared = shareConnectors(inl.model);
  const m = shared.notes.length ? { ...inl.model, lines: shared.lines } : inl.model;
  // a branch that cannot be written (too few connectable points) must not leave a tee with a loose n3:
  // build once, then rebuild without the tees of those branches
  const first = buildOnce(m, project, origin, new Set(), routers);
  const out = first.unwritten.size ? buildOnce(m, project, origin, first.unwritten, routers) : first;
  out.warnings.unshift(...inl.notes, ...shared.notes);
  return out;
}

/**
 * An instrument listed among a run's components (an in-line flow meter or controller) is written as an
 * instrument, not also as a piping component: it comes off the run's component list, and a branch
 * placed after it is placed after the component before it.
 */
function instrumentsOffRuns(model: DrawingModel): { model: DrawingModel; notes: string[] } {
  const isInst = new Set(model.items.filter((i) => i.category === "instrument").map((i) => i.id));
  const notes: string[] = [];
  const before = new Map<string, string | null>(); // `${line}|${instrument}` → kept component before it
  const lines = model.lines.map((l) => {
    if (!l.components.some((c) => isInst.has(c))) return l;
    let prev: string | null = null;
    const kept: string[] = [];
    for (const c of l.components) {
      if (isInst.has(c)) {
        before.set(`${l.id}|${c}`, prev);
        notes.push(`${l.id}: instrument ${model.items.find((i) => i.id === c)?.tag ?? c} was listed as a run component; written as instrument only.`);
      } else (kept.push(c), (prev = c));
    }
    return { ...l, components: kept };
  });
  if (!notes.length) return { model, notes };
  const fix = <E extends { kind: string; ref?: string | null; after?: string | null }>(e: E): E =>
    e.kind === "line" && e.ref && e.after && before.has(`${e.ref}|${e.after}`) ? { ...e, after: before.get(`${e.ref}|${e.after}`)! } : e;
  return { model: { ...model, lines: lines.map((l) => ({ ...l, from: fix(l.from), to: fix(l.to) })) }, notes };
}

/**
 * Loops from the drawn signal chains, for bubbles without a loop number (TT → TIC → TV, LE → LT → LIC).
 * Instruments joined by instrument→instrument signals form a chain. A chain holding instruments of
 * exactly one numbered loop adds its unnumbered members to that loop; a chain without any number
 * becomes a loop of its own, named after its lead instrument (controller, else transmitter) and
 * what the chain measures, e.g. "LIC/VTK-58E". Chains with two loop numbers, and unnumbered chains
 * with two bubbles of one letter code measuring different things, are left alone.
 * Returns the loops to set (number → members), numbered ones included when they grew.
 */
function chainLoops(model: DrawingModel, numbered: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const isInst = (id: string) => byId.get(id)?.category === "instrument";
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const s of model.signals) {
    if (s.kind !== "signal" || !isInst(s.instrument) || !isInst(s.target) || s.instrument === s.target) continue;
    const a = find(s.instrument), b = find(s.target);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    if (a !== b) parent.set(b, a);
  }
  const chains = new Map<string, string[]>();
  for (const x of parent.keys()) chains.set(find(x), [...(chains.get(find(x)) ?? []), x]);
  const numberOf = new Map<string, string>();
  for (const [n, ids] of numbered) for (const id of ids) numberOf.set(id, n);
  const lead = (id: string) => {
    const { functions, letters } = splitInstrumentTag(byId.get(id)?.tag ?? null);
    const f = functions || letters;
    return /C/.test(f.slice(1)) ? 3 : /T$/.test(f) ? 2 : /E$/.test(f) ? 1 : 0;
  };
  const label = (id: string) => byId.get(id)?.tag ?? model.lines.find((l) => l.id === id)?.line_id ?? id;
  for (const members of chains.values()) {
    const nums = [...new Set(members.map((m) => numberOf.get(m)).filter((n): n is string => Boolean(n)))];
    const loose = members.filter((m) => !numberOf.has(m));
    if (!loose.length || nums.length > 1) continue;
    if (nums.length === 1) {
      out.set(nums[0], [...new Set([...(numbered.get(nums[0]) ?? []), ...loose])]);
      continue;
    }
    // two bubbles of one code measuring different things (two channels on one drive): not one loop
    const seen = new Map<string, string>();
    const clash = members.some((m) => {
      const code = splitInstrumentTag(byId.get(m)?.tag ?? null).letters;
      const tgt = model.signals.find((s) => s.instrument === m && s.kind === "measures")?.target;
      if (!code || !tgt) return false;
      if (seen.has(code) && seen.get(code) !== tgt) return true;
      seen.set(code, tgt);
      return false;
    });
    if (clash) continue;
    const head = [...members].sort((a, b) => lead(b) - lead(a))[0];
    const sensed = model.signals.find((s) => members.includes(s.instrument) && s.kind === "measures");
    let name = `${byId.get(head)?.tag ?? head}${sensed ? `/${label(sensed.target)}` : ""}`;
    for (let k = 2; numbered.has(name) || out.has(name); k++) name = `${byId.get(head)?.tag ?? head}${sensed ? `/${label(sensed.target)}` : ""} (${k})`;
    out.set(name, members);
  }
  return out;
}

/**
 * An off-page connector has one node, so it can end one run only. Where the tracer ends several
 * runs at it (condensate lines into one return header; a run into a jump label and on out of it),
 * the run with the most components keeps the connector and the others join it with a tee right
 * next to the connector (after its last component, or at its start when it leaves the connector).
 * Works on a copy of the runs; the drawing model is left as traced.
 */
function shareConnectors(model: DrawingModel): { lines: Line[]; notes: string[] } {
  const lines = model.lines.map((l) => ({ ...l, from: { ...l.from }, to: { ...l.to } }));
  const notes: string[] = [];
  const ends = new Map<string, { l: Line; side: "from" | "to" }[]>();
  for (const l of lines)
    for (const side of ["from", "to"] as const) {
      const e = l[side];
      if (e.kind === "off_page" && e.ref) ends.set(e.ref, [...(ends.get(e.ref) ?? []), { l, side }]);
    }
  const tag = (id: string) => model.items.find((i) => i.id === id)?.tag ?? id;
  for (const [opc, list] of ends) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => b.l.components.length - a.l.components.length)[0];
    const at: Endpoint = { kind: "line", ref: keep.l.id, after: keep.side === "to" ? (keep.l.components[keep.l.components.length - 1] ?? null) : null };
    const joined: string[] = [];
    for (const x of list) {
      if (x === keep || x.l === keep.l) continue; // a run at both sides of one connector stays as it is
      x.l[x.side] = { ...at };
      joined.push(x.l.line_id ?? x.l.id);
    }
    if (joined.length) notes.push(`${tag(opc)}: ${list.length} runs meet at this off-page connector; ${joined.join(", ")} joined to ${keep.l.line_id ?? keep.l.id} with a tee next to it.`);
  }
  return { lines, notes };
}

function buildOnce(model: DrawingModel, project: string, origin: string, skipBranches: Set<string>, routers?: Map<number, PageRouter>) {
  const unwritten = new Set<string>();
  const itemById = new Map(model.items.map((i) => [i.id, i]));
  const warnings: string[] = [];
  const trace: DexpiTrace = { equipment: [], lines: [], nozzles: [], instruments: [] };
  const eqNozzles = new Map<string, Node[]>(); // equipment id → nozzle nodes
  const nozzleCount = new Map<string, number>();
  const newNozzle = (eqId: string, instrument = false, printed?: string) => {
    const n = (nozzleCount.get(eqId) ?? 0) + 1;
    nozzleCount.set(eqId, n);
    const id = `${eqId}.N${n}`;
    const node: Node = obj(`Plant/ProcessEquipment.${instrument ? "InstrumentNozzle" : "ProcessNozzle"}`, id, nn([comps("Nodes", [obj("Plant/Piping.PipingNode", `${id}.node`, [])]), str("SubTagName", printed ?? `N${n}`)]));
    eqNozzles.set(eqId, [...(eqNozzles.get(eqId) ?? []), node]);
    trace.nozzles.push({ id, node: `${id}.node`, eq: eqId, instrument });
    return { item: id, node: `${id}.node` };
  };

  // components may appear on one line only; off-page connectors at one line end only
  const usedOpc = new Set<string>();
  const forcedOperated = new Set<string>(model.signals.filter((s) => s.kind === "actuates").map((s) => s.target));

  // branches: tees inserted into the parent line
  interface Tee { id: string; parent: string; after: string | null; branch: string; at?: { page: number; p: [number, number] } }
  const tees: Tee[] = [];
  const branchTee = new Map<string, Tee>(); // `${line}|from|to` → tee
  for (const l of model.lines)
    for (const end of ["from", "to"] as const) {
      const e = l[end];
      if (e.kind !== "line" || !e.ref || skipBranches.has(l.id)) continue;
      const parent = model.lines.find((p) => p.id === e.ref);
      if (!parent || parent.id === l.id) continue;
      const tee: Tee = { id: `${safeId(parent.id)}.T${tees.filter((t) => t.parent === parent.id).length + 1}`, parent: parent.id, after: e.after, branch: l.id, at: e.at ? { page: l.page, p: e.at } : undefined };
      tees.push(tee);
      branchTee.set(`${l.id}|${end}`, tee);
    }

  const segOfItem = new Map<string, string>(); // item id → segment id (for sensing/actuating locations)
  // Equipment drawn inline on a run (filter, reducer, sight glass …) is written as a piping component
  // of that run, not also as equipment — unless a run ends at it (then it needs nozzles and stays equipment).
  const endsAtEq = new Set(model.lines.flatMap((l) => [l.from, l.to]).filter((e) => e.kind === "equipment" && e.ref).map((e) => e.ref!));
  const inlineEq = new Set(model.lines.flatMap((l) => l.components).filter((c) => itemById.get(c)?.category === "equipment" && !endsAtEq.has(c)));
  const lineFirstSeg = new Map<string, string>();
  const systems: Node[] = [];

  for (const l of model.lines) {
    const sysId = safeId(l.id);
    type Seq = ({ kind: "end"; item: string; node: string; obj?: Node } | { kind: "comp"; id: string; obj: Node } | { kind: "tee"; id: string; obj: Node }) & { tr: TraceElem };
    const seq: Seq[] = [];

    const endpoint = (e: Endpoint, end: "from" | "to"): Seq | null => {
      if (e.kind === "equipment" && e.ref && itemById.get(e.ref)?.category === "equipment") {
        const nz = newNozzle(e.ref, false, e.nozzle);
        return { kind: "end", ...nz, tr: { kind: "nozzle", id: nz.item, node: nz.node, eq: e.ref } };
      }
      if (e.kind === "off_page" && e.ref && itemById.has(e.ref) && !usedOpc.has(e.ref)) {
        usedOpc.add(e.ref);
        const it = itemById.get(e.ref)!;
        const cls = end === "from" ? "FlowInPipeOffPageConnector" : "FlowOutPipeOffPageConnector";
        const o = obj(`Plant/Piping.${cls}`, it.id, nn([comps("Nodes", [obj("Plant/Piping.PipingNode", `${it.id}.node`, [])]), mls("PipeConnectorDescription", [it.tag, it.description, it.service].filter(Boolean).join(" — ") || null), str("PipeConnectorNumber", it.tag)]));
        return { kind: "end", item: it.id, node: `${it.id}.node`, obj: o, tr: { kind: "opc", id: it.id, node: `${it.id}.node`, inlet: end === "from" } };
      }
      if (e.kind === "line") {
        const t = branchTee.get(`${l.id}|${end}`);
        if (t) return { kind: "end", item: t.id, node: `${t.id}.n3`, tr: { kind: "teeEnd", id: t.id, node: `${t.id}.n3` } };
      }
      if (e.kind === "off_page" && e.ref && usedOpc.has(e.ref)) warnings.push(`${l.id}: off-page connector ${e.ref} already ends another run; this end left open.`);
      return null;
    };

    const start = endpoint(l.from, "from");
    if (start) seq.push(start);
    const pushTeesAfter = (after: string | null) => {
      for (const t of tees.filter((t) => t.parent === l.id && t.after === after))
        seq.push({ kind: "tee", id: t.id, obj: obj("Plant/Piping.PipeTee", t.id, nn([str("FluidCode", l.service), comps("Nodes", [1, 2, 3].map((k) => obj("Plant/Piping.PipingNode", `${t.id}.n${k}`, [])))])), tr: { kind: "tee", id: t.id, nodes: [`${t.id}.n1`, `${t.id}.n2`, `${t.id}.n3`], at: t.at } });
    };
    pushTeesAfter(null);
    for (const c of l.components) {
      const it = itemById.get(c);
      if (!it || segOfItem.has(c)) continue;
      if (it.category === "equipment" && !inlineEq.has(c)) {
        warnings.push(`${l.id}: ${it.tag ?? c} is equipment that a run also ends at — left out of this run's components.`);
        continue;
      }
      let cls = pipingClass(it);
      if (forcedOperated.has(c) && cls !== "OperatedValve") {
        warnings.push(`${it.tag ?? c}: driven by a controller, written as OperatedValve (symbol read as ${cls}).`);
        cls = "OperatedValve";
      }
      seq.push({
        kind: "comp",
        id: c,
        obj: obj(`Plant/Piping.${cls}`, c, nn([str("FluidCode", l.service), comps("Nodes", [obj("Plant/Piping.PipingNode", `${c}.n1`, []), obj("Plant/Piping.PipingNode", `${c}.n2`, [])]), ...(NO_COMPONENT_NAME.has(cls) ? [] : [str("PipingComponentName", it.description), str("PipingComponentNumber", it.tag)])])),
        tr: { kind: "comp", id: c, cls, n1: `${c}.n1`, n2: `${c}.n2`, hasNumber: !NO_COMPONENT_NAME.has(cls) && Boolean(it.tag) },
      });
      segOfItem.set(c, "");
      pushTeesAfter(c);
    }
    // tees whose 'after' component is not on this line go at the end
    for (const t of tees.filter((t) => t.parent === l.id && t.after && !l.components.includes(t.after))) {
      seq.push({ kind: "tee", id: t.id, obj: obj("Plant/Piping.PipeTee", t.id, nn([str("FluidCode", l.service), comps("Nodes", [1, 2, 3].map((k) => obj("Plant/Piping.PipingNode", `${t.id}.n${k}`, [])))])), tr: { kind: "tee", id: t.id, nodes: [`${t.id}.n1`, `${t.id}.n2`, `${t.id}.n3`], at: t.at } });
    }
    const endSeq = endpoint(l.to, "to");
    if (endSeq) seq.push(endSeq);
    if (seq.length < 2) {
      warnings.push(`${l.id}: fewer than two connectable points (both ends open, no components) — not written.`);
      unwritten.add(l.id);
      continue;
    }

    // split into segments at tees (tee closes segment k with n1, opens k+1 with n2)
    const segments: Node[] = [];
    const segTrace: TraceLine["segments"] = [];
    let cur: Seq[] = [];
    let segStart: { item: string; node: string } | null = null;
    let segN = 0;
    const out = (s: Seq) => (s.kind === "end" ? { item: s.item, node: s.node } : s.kind === "tee" ? { item: s.id, node: `${s.id}.n2` } : { item: s.id, node: `${s.id}.n2` });
    const inn = (s: Seq) => (s.kind === "end" ? { item: s.item, node: s.node } : { item: s.id, node: `${s.id}.n1` });
    const flush = (endPoint: { item: string; node: string } | null) => {
      segN++;
      const segId = `${sysId}.S${segN}`;
      if (segN === 1) lineFirstSeg.set(l.id, segId);
      const pipes: Node[] = [];
      const pipeTrace: TraceLine["segments"][number]["pipes"] = [];
      let prev = segStart;
      let pn = 0;
      for (const s of cur) {
        if (prev) {
          const target = inn(s);
          pipeTrace.push({ id: `${segId}.P${pn + 1}`, src: prev.node, tgt: target.node });
          pipes.push(obj("Plant/Piping.Pipe", `${segId}.P${++pn}`, nn([ref("SourceItem", prev.item), ref("SourceNode", prev.node), ref("TargetItem", target.item), ref("TargetNode", target.node)])));
        }
        prev = s.kind === "tee" ? null : out(s);
        if (s.kind === "comp") segOfItem.set(s.id, segId);
      }
      segTrace.push({ id: segId, members: cur.map((s) => (s.kind === "end" ? s.item : s.id)), pipes: pipeTrace });
      const items = cur.filter((s) => s.kind !== "end" || s.obj).map((s) => (s.kind === "end" ? s.obj! : s.obj));
      const first = segStart ?? (cur[0] ? inn(cur[0]) : null);
      const last = endPoint;
      segments.push(
        obj("Plant/Piping.PipingNetworkSegment", segId, nn([
          comps("Connections", pipes),
          str("FluidCode", l.service),
          comps("Items", items),
          str("NominalDiameterRepresentation", l.size),
          str("PipingClassCode", l.spec),
          str("SegmentNumber", `S${segN}`),
          ref("SourceItem", first?.item), ref("SourceNode", first?.node),
          ref("TargetItem", last?.item), ref("TargetNode", last?.node),
        ])),
      );
    };
    // walk
    for (let k = 0; k < seq.length; k++) {
      const s = seq[k];
      if (k === 0 && s.kind === "end") {
        if (s.obj) cur.push(s); // off-page connector object lives in the segment; it is its own start
        else segStart = { item: s.item, node: s.node };
        continue;
      }
      cur.push(s);
      if (s.kind === "tee" && k < seq.length - 1) {
        flush({ item: s.id, node: `${s.id}.n1` });
        cur = [];
        segStart = { item: s.id, node: `${s.id}.n2` };
      }
    }
    const lastS = seq[seq.length - 1];
    flush(lastS.kind === "end" ? { item: lastS.item, node: lastS.node } : lastS.kind === "comp" ? { item: lastS.id, node: `${lastS.id}.n2` } : { item: lastS.id, node: `${lastS.id}.n2` });

    trace.lines.push({ id: l.id, sys: sysId, label: l.line_id ?? l.id, service: l.service, elems: seq.map((s) => s.tr), segments: segTrace });
    systems.push(obj("Plant/Piping.PipingNetworkSystem", sysId, nn([
      str("FluidCode", l.service),
      str("LineNumber", l.line_id ?? l.id),
      str("NominalDiameterRepresentation", l.size),
      str("PipingClassCode", l.spec),
      str("InsulationType", l.insulation),
      comps("Segments", segments),
    ])));
  }

  // components that ended up on no line cannot be written as piping items
  const orphans = model.items.filter((i) => (i.category === "valve" || i.category === "piping_component") && !segOfItem.get(i.id));
  if (orphans.length) warnings.push(`${orphans.length} valves/components are on no traced run and are not in the DEXPI model: ${orphans.map((o) => o.tag ?? o.id).join(", ")}`);
  const unusedOpc = model.items.filter((i) => i.category === "off_page" && !usedOpc.has(i.id));
  if (unusedOpc.length) warnings.push(`${unusedOpc.length} off-page connectors are not at the end of a traced run: ${unusedOpc.map((o) => o.tag ?? o.id).join(", ")}`);

  // a run measured as a whole: sense on its segment nearest to the tap point (or the bubble), not on its first
  const center = (b: number[]): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const nearestSegment = (lineId: string, p: [number, number]): string | null => {
    const tl = trace.lines.find((t) => t.id === lineId);
    if (!tl || tl.segments.length < 2) return null;
    const distSeg = (q: [number, number], a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
      return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
    };
    let best: string | null = null, bd = Infinity;
    for (const sg of tl.segments) {
      const pts = sg.members.map((m) => itemById.get(m) ?? itemById.get(m.replace(/\.N\d+$/, ""))).filter((x): x is Item => Boolean(x)).map((x) => center(x.bbox));
      if (!pts.length) continue;
      const d = pts.length === 1 ? Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) : Math.min(...pts.slice(1).map((b, k) => distSeg(p, pts[k], b)));
      if (d < bd) [best, bd] = [sg.id, d];
    }
    return best;
  };

  // instrumentation
  const pifs: Node[] = [];
  const actuating: Node[] = [];
  const loops = new Map<string, string[]>();
  // drawn signal lines (vector layer): their ISA 5.1 pattern gives the conveying type
  const slType = new Map((model.signal_lines ?? []).map((l) => [l.id, l.type]));
  const CONVEY: Record<string, string> = { electrical: "Electrical", pneumatic: "Pneumatic", capillary: "Capillary" };
  const conveying = (via?: string) => {
    const t = via ? CONVEY[slType.get(via) ?? ""] : undefined;
    return t ? enumRef("SignalConveyingType", `Plant/Enumerations.SignalConveyingTypeClassification.${t}SignalConveying`) : null;
  };
  const isInstrument = new Set(model.items.filter((x) => x.category === "instrument").map((x) => x.id));
  for (const i of model.items.filter((x) => x.category === "instrument")) {
    const { letters, number, category, functions } = splitInstrumentTag(i.tag);
    const id = i.id;
    const measures = model.signals.find((s) => s.instrument === id && s.kind === "measures");
    let sensing: string | null = null;
    let sensKind: "nozzle" | "segment" = "segment";
    if (measures) {
      const tgt = itemById.get(measures.target);
      if (tgt?.category === "equipment" && !inlineEq.has(tgt.id)) {
        sensing = newNozzle(tgt.id, true).item;
        sensKind = "nozzle";
      }
      else if (tgt && segOfItem.get(tgt.id)) sensing = segOfItem.get(tgt.id)!;
      else if (lineFirstSeg.has(measures.target)) sensing = nearestSegment(measures.target, measures.at ?? center(i.bbox)) ?? lineFirstSeg.get(measures.target)!;
    }
    const acts = model.signals.filter((s) => s.instrument === id && s.kind === "actuates" && segOfItem.get(s.target));
    const af: Node[] = [];
    const conv: Node[] = [];
    const actTrace: DexpiTrace["instruments"][number]["acts"] = [];
    acts.forEach((a, k) => {
      const asId = `${id}.AS${k + 1}`;
      const afId = `${id}.AF${k + 1}`;
      const valve = itemById.get(a.target)!;
      actTrace.push({ as: asId, ca: `${asId}.CA`, sl: `${id}.SL${k + 1}`, valve: valve.id, number: `${valve.tag ?? valve.id}-ACT`, via: a.via });
      actuating.push(obj("Plant/Instrumentation.ActuatingSystem", asId, nn([
        str("ActuatingSystemNumber", `${valve.tag ?? valve.id}-ACT`),
        comps("ControlledActuator", [obj("Plant/Instrumentation.ControlledActuator", `${asId}.CA`, nn([str("SubTagName", `${valve.tag ?? valve.id}-ACT_Y`)]))]),
        comps("OperatedValveReference", [obj("Plant/Instrumentation.OperatedValveReference", null, nn([str("SubTagName", `${valve.tag ?? valve.id}-ACT_V`), ref("Valve", valve.id)]))]),
      ])));
      af.push(obj("Plant/Instrumentation.ActuatingFunction", afId, nn([str("ActuatingFunctionNumber", `${valve.tag ?? valve.id}-ACT`), ref("ActuatingLocation", segOfItem.get(valve.id)), ref("Systems", asId)])));
      conv.push(obj("Plant/Instrumentation.SignalLineFunction", `${id}.SL${k + 1}`, nn([conveying(a.via), ref("Source", id), ref("Target", afId)])));
    });
    // instrument → instrument (transmitter to controller, controller to controller, …)
    const sigTrace: DexpiTrace["instruments"][number]["sigs"] = [];
    model.signals
      .filter((s) => s.instrument === id && s.kind === "signal" && isInstrument.has(s.target) && s.target !== id)
      .forEach((s, k) => {
        const sid = `${id}.SS${k + 1}`;
        sigTrace.push({ id: sid, target: s.target, via: s.via, inferred: s.basis === "loop" });
        conv.push(obj("Plant/Instrumentation.SignalLineFunction", sid, nn([conveying(s.via), ref("Source", id), ref("Target", s.target)])));
      });
    const psgf = obj("Plant/Instrumentation.ProcessSignalGeneratingFunction", `${id}.PSGF`, nn([str("ProcessSignalGeneratingFunctionNumber", i.tag ?? id), ref("SensingLocation", sensing)]));
    conv.unshift(obj("Plant/Instrumentation.MeasuringLineFunction", `${id}.ML`, nn([conveying(measures?.via), ref("Source", `${id}.PSGF`), ref("Target", id)])));
    pifs.push(obj("Plant/Instrumentation.ProcessInstrumentationFunction", id, nn([
      comps("ActuatingFunctions", af),
      str("ProcessInstrumentationFunctionCategory", category || null),
      str("ProcessInstrumentationFunctionNumber", number || null),
      str("ProcessInstrumentationFunctions", functions || null),
      comps("ProcessSignalGeneratingFunctions", [psgf]),
      comps("SignalConveyingFunctions", conv),
    ])));
    trace.instruments.push({ id, sensing: sensing ? { kind: sensKind, id: sensing } : null, ml: `${id}.ML`, mlVia: measures?.via, tap: measures?.at ? { page: i.page, at: measures.at } : undefined, acts: actTrace, sigs: sigTrace, category: Boolean(category), functions: Boolean(functions), number: Boolean(number) });
    if (number) loops.set(number, [...(loops.get(number) ?? []), id]);
  }
  for (const [n, ids] of chainLoops(model, loops)) loops.set(n, ids);
  const loopNodes = [...loops.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([n, ids]) => obj("Plant/Instrumentation.InstrumentationLoopFunction", `LOOP-${safeId(n)}`, nn([str("InstrumentationLoopFunctionNumber", n), ref("ProcessInstrumentationFunctions", ...ids)])));

  // equipment (after lines, so nozzles exist)
  const equipment = model.items
    .filter((i) => i.category === "equipment" && !inlineEq.has(i.id))
    .map((i) => {
      trace.equipment.push({ id: i.id, cls: equipmentClass(i) });
      return obj(`Plant/ProcessEquipment.${equipmentClass(i)}`, i.id, nn([
        mls("EquipmentDescription", [i.description, i.service].filter(Boolean).join(" — ") || i.type),
        comps("Nozzles", eqNozzles.get(i.id) ?? []),
        str("TagName", i.tag ?? i.id),
      ]));
    });

  const tb = model.title_block;
  const meta = obj("Plant/Diagram.PlantMetaData", "PlantMetaData1", nn([
    str("CreationDateRepresentation", new Date().toISOString().slice(0, 10)),
    str("CreatorName", "pid-to-dexpi (Claude vision pipeline, digitised from PDF — engineer review required)"),
    str("DrawingName", tb.title),
    str("DrawingNumber", tb.drawing_number),
    mls("DrawingSubTitle", [tb.author, tb.date].filter(Boolean).join(", ") || null),
    str("EnterpriseName", tb.client),
    str("PlantSystemName", tb.unit),
    str("ProcessPlantName", tb.plant),
    str("ProjectName", project),
    str("ProjectNumber", tb.project_number),
    str("RevisionNumber", tb.revision),
    str("SheetNumber", tb.sheet),
  ]));

  const plant = obj("Plant/PlantModel", "PlantModel1", nn([
    comps("ActuatingSystems", actuating),
    comps("InstrumentationLoopFunctions", loopNodes),
    comps("MetaData", [meta]),
    comps("PipingNetworkSystems", systems),
    comps("ProcessInstrumentationFunctions", pifs),
    comps("TaggedPlantItems", equipment),
  ]));
  const drawing = buildDiagram(model, trace, routers);
  const { diagram, catalogue } = diagramXml(drawing);
  const root = obj("Core/EngineeringModel", null, nn([
    comps("ConceptualModel", [plant]),
    comps("Diagram", [diagram]),
    `<Data property="ExportDateTime"><DateTime>${new Date().toISOString().slice(0, 19)}</DateTime></Data>`,
    str("OriginatingSystemName", "pid-to-dexpi"),
    str("OriginatingSystemVendorName", "DeHeij"),
    str("OriginatingSystemVersion", origin),
    comps("ShapeCatalogues", [catalogue]),
  ]));
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='no'?>
<Model name="${esc(project)}" uri="urn:pid-to-dexpi:${esc(safeId(project))}">
  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>
  <Import prefix="Plant" source="https://data.dexpi.org/models/2.0.1/Plant.xml"/>
${render(root, 1)}
</Model>
`;
  const stats = {
    equipment: equipment.length,
    piping_network_systems: systems.length,
    piping_components: [...segOfItem.values()].filter(Boolean).length,
    tees: tees.length,
    off_page_connectors: usedOpc.size,
    instrumentation_functions: pifs.length,
    loops: loopNodes.length,
    actuating_systems: actuating.length,
    diagram_symbols: drawing.usedShapes.size,
  };
  return { unwritten, xml, svg: diagramSvg(drawing), warnings: [...warnings, ...drawing.notes, ...selfCheck(xml)], stats };
}

/** Structural self-check: unique ids and every #reference resolves. */
export function selfCheck(xml: string) {
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const set = new Set(ids);
  const errs: string[] = [];
  if (set.size !== ids.length) {
    const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
    errs.push(`ERROR duplicate ids: ${[...new Set(dup)].slice(0, 10).join(", ")}`);
  }
  for (const m of xml.matchAll(/objects="([^"]+)"/g))
    for (const r of m[1].split(" ")) if (!set.has(r.replace(/^#/, ""))) errs.push(`ERROR dangling reference ${r}`);
  return errs;
}

export function dexpi(ctx: RunContext) {
  const model = ctx.bag.model as DrawingModel;
  const { xml, svg, warnings, stats } = buildDexpi(model, ctx.state.project, `0.1 (source: ${model.document})`, pageRouters(ctx, model));
  ctx.writeText(`${ctx.state.project}.dexpi.xml`, xml);
  ctx.writeText(`${ctx.state.project}.dexpi.svg`, svg);
  ctx.writeJSON("dexpi_report.json", { stats, warnings });
  const errors = warnings.filter((w) => w.startsWith("ERROR"));
  ctx.log("dexpi", `DEXPI 2.0.1 written: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(", ")}; ${errors.length} errors, ${warnings.length - errors.length} warnings`);
  if (errors.length) throw new Error(`DEXPI self-check failed: ${errors.slice(0, 3).join("; ")}`);
  ctx.bag.dexpiWarnings = warnings;
  return stats;
}

/** Routers over the drawn pipes of each vector page (none for a scan), for the drawing layer. */
export function pageRouters(ctx: RunContext, model: DrawingModel): Map<number, PageRouter> {
  const out = new Map<number, PageRouter>();
  try {
    const pages = model.pages.map((pg) => ({ n: pg.n, file: `${ctx.dir}/${pg.image}`, rel: pg.image, W: pg.px[0], H: pg.px[1] }));
    for (const [n, nets] of computeNets(ctx, model, pages)) {
      const pg = pages.find((x) => x.n === n)!;
      const boxes = model.items.filter((i) => i.page === n).map((i) => i.bbox);
      const apparatus = model.items.filter((i) => i.page === n && i.category === "equipment").map((i) => i.bbox);
      const r = buildRouter(nets, boxes, pg.W, apparatus);
      const pw = pipeWidth(nets);
      r.signal = buildRouter(nets.filter((x) => x.dash || x.w < 0.7 * pw).map((x) => ({ ...x, dash: false })), boxes, pg.W, apparatus);
      out.set(n, r);
    }
  } catch (e) {
    ctx.log("dexpi", `drawn routes skipped: ${(e as Error).message}`);
  }
  return out;
}
