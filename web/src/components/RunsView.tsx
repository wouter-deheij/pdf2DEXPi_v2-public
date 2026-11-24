import { useEffect, useState } from "react";
import { api, type RunInfo } from "../api";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
/** one number to compare runs by: how well the drawing lies on the PDF (precision and pipe recall) */
const fit = (r: RunInfo) => (r.overlay && r.overlay.precision !== null && r.overlay.pipeRecall !== null ? (r.overlay.precision + r.overlay.pipeRecall) / 2 : null);
const KIND: Record<string, string> = { open_point: "open punt", missed: "getekend, niet gebruikt", invented: "niet op de tekening", note: "jouw opmerking" };

function kindOf(r: RunInfo) {
  if (!r.rerun) return "eerste lezing";
  if (r.rerun.kind === "correction") {
    const v = r.rerun.accepted === undefined ? "" : r.rerun.accepted ? " — overgenomen" : " — niet overgenomen";
    return `correctie van run ${r.rerun.from ?? "—"}${v}`;
  }
  return `herlezing van run ${r.rerun.from ?? "—"}${r.rerun.notes.trim() ? " + opmerkingen" : ""}`;
}

/** Every run of the project side by side; pick the active one, correct it, or read the drawing again. */
export default function RunsView({ project, runs, running, onChange }: { project: string; runs: RunInfo[]; running: boolean; onChange: () => void }) {
  const [notes, setNotes] = useState("");
  const [points, setPoints] = useState<{ points: { kind: string; text: string }[]; unplaced: string[] } | null>(null);
  const [showPoints, setShowPoints] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // what a correction would look at follows the notes (debounced)
  useEffect(() => {
    const t = setTimeout(() => api.correctPreview(project, notes).then(setPoints).catch(() => setPoints(null)), 300);
    return () => clearTimeout(t);
  }, [project, notes, runs.length]);

  const scored = runs.filter((r) => fit(r) !== null);
  // better overlay wins; at (nearly) equal overlay, fewer open points wins — the same rule the correction guard uses
  const better = (a: RunInfo, b: RunInfo) =>
    Math.abs(fit(b)! - fit(a)!) > 0.002 ? fit(b)! > fit(a)! : (b.open_points ?? Infinity) < (a.open_points ?? Infinity);
  const best = scored.length > 1 ? scored.reduce((a, b) => (better(a, b) ? b : a)) : null;

  const act = async (fn: () => Promise<unknown>, clear = false) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (clear) setNotes("");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="runs">
      <p className="small muted">
        Elke run wordt volledig bewaard (model, tabellen, databases, DEXPI, overlay, open punten, log) in <code>output/{project}/runs/</code>. De actieve run is wat de andere tabbladen tonen.
      </p>
      <div className="scroll-x">
        <table className="data">
          <thead>
            <tr>
              <th>run</th>
              <th>gestart</th>
              <th>status</th>
              <th className="num">op de PDF</th>
              <th className="num">leiding gevolgd</th>
              <th className="num">signaal gevolgd</th>
              <th className="num">open punten</th>
              <th className="num">app. / instr. / kleppen / leidingen</th>
              <th className="num">kosten</th>
              <th>soort</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.n} className={r.active ? "active-row" : ""}>
                <td>
                  {r.n}
                  {best?.n === r.n && <span className="badge" title="Beste overlay: gemiddelde van 'op de PDF' en 'leiding gevolgd'">beste</span>}
                </td>
                <td>{r.started_at ? new Date(r.started_at).toLocaleString("nl-NL") : "—"}</td>
                <td>
                  <span className={`status status-${r.status}`}>{r.status}</span>
                </td>
                <td className="num">{r.overlay ? pct(r.overlay.precision) : "—"}</td>
                <td className="num">{r.overlay ? pct(r.overlay.pipeRecall) : "—"}</td>
                <td className="num">{r.overlay ? pct(r.overlay.signalRecall) : "—"}</td>
                <td className="num">{r.open_points ?? "—"}</td>
                <td className="num">{r.counts ? `${r.counts.equipment} / ${r.counts.instruments} / ${r.counts.valves} / ${r.counts.lines}` : "—"}</td>
                <td className="num">{r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(2)}` : "—"}</td>
                <td className="small" title={r.rerun?.verdict ?? ""}>
                  {kindOf(r)}
                </td>
                <td>{r.active ? <strong className="small">actief</strong> : <button disabled={busy || running || r.status === "running"} onClick={() => act(() => api.activateRun(project, r.n))}>Maak actief</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {runs.some((r) => r.rerun?.verdict || r.rerun?.notes.trim()) && (
        <details className="small">
          <summary>Uitkomst en opmerkingen van eerdere correcties en herlezingen</summary>
          <ul>
            {runs.filter((r) => r.rerun?.verdict || r.rerun?.notes.trim()).map((r) => (
              <li key={r.n}>
                run {r.n}: {[r.rerun!.verdict, r.rerun!.notes.trim() && `opmerkingen: ${r.rerun!.notes}`].filter(Boolean).join(" · ")}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="card rerun">
        <h4 style={{ margin: 0 }}>Verbeteren</h4>
        <p className="small muted" style={{ margin: 0 }}>
          <strong>Correctie</strong> (aanbevolen): de lezing van de actieve run blijft staan; alleen de open punten, de plekken waar de overlay afwijkt en wat je hieronder noemt worden ingezoomd opnieuw bekeken. De correctie wordt alleen actief als de tekening minstens zo goed op de PDF ligt en er niet meer open punten zijn; anders blijft de huidige run actief en staat de correctie ernaast. <strong>Volledig opnieuw lezen</strong> leest de hele tekening opnieuw (kosten als een eerste run) en kan elders slechter uitvallen.
        </p>
        <label className="small muted" htmlFor="rerun-notes">
          Jouw opmerkingen (optioneel); noem tags, dan wordt daar ook gekeken, bijvoorbeeld "45-BFV-210 is een vlinderklep met aparte terugslagklep"
        </label>
        <textarea id="rerun-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Wat moet er beter?" />
        <div className="row wrap between">
          <span className="small muted">
            {points ? `Correctie bekijkt ${points.points.length} punten opnieuw${points.unplaced.length ? ` (${points.unplaced.length} open punten zonder item blijven staan)` : ""}.` : "—"}{" "}
            {points && points.points.length > 0 && (
              <button className="linklike" onClick={() => setShowPoints((v) => !v)}>
                {showPoints ? "verberg" : "bekijk"} de punten
              </button>
            )}
          </span>
          <span className="row">
            <button disabled={busy || running} onClick={() => act(() => api.rerun(project, notes), true)} title="De hele tekening opnieuw lezen, met de open punten en overlay als aanwijzingen">
              Volledig opnieuw lezen
            </button>
            <button className="primary" disabled={busy || running || !points?.points.length} onClick={() => act(() => api.correct(project, notes), true)}>
              {running ? "Er loopt al een run…" : "Correctie draaien"}
            </button>
          </span>
        </div>
        {showPoints && points && (
          <ol className="small">
            {points.points.map((p, k) => (
              <li key={k}>
                <span className="muted">[{KIND[p.kind] ?? p.kind}]</span> {p.text}
              </li>
            ))}
          </ol>
        )}
        {err && <div className="bad small">{err}</div>}
      </div>
    </div>
  );
}
