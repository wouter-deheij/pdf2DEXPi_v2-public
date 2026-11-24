import { useEffect, useState } from "react";
import { api, type ProjectDetail, type RunState } from "../api";
import { StatusDot } from "../App";
import PipelineGraph from "./PipelineGraph";
import DrawingView from "./DrawingView";
import TablesView from "./TablesView";
import KeyView from "./KeyView";
import OverlayView from "./OverlayView";
import RunsView from "./RunsView";

const TABS = ["Tekening", "Tabellen", "Open punten", "DEXPI", "Overlay", "Runs", "Sleutel", "Log", "Bestanden"] as const;
type Tab = (typeof TABS)[number];

export default function ProjectView({ project, onChange }: { project: string; onChange: () => void }) {
  const [d, setD] = useState<ProjectDetail | null>(null);
  const [live, setLive] = useState<RunState | null>(null);
  const [tab, setTab] = useState<Tab>("Tekening");
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.project(project).then(setD).catch((e) => setErr(e.message));
  const [watch, setWatch] = useState(0); // a new run started here: follow its live stream

  useEffect(() => {
    load();
    const es = new EventSource(`/api/projects/${encodeURIComponent(project)}/events`);
    let lastStage = "";
    es.addEventListener("update", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as RunState;
      setLive(s);
      const doneStages = s.stages.filter((x) => x.status === "done").map((x) => x.id).join();
      if (doneStages !== lastStage) {
        lastStage = doneStages;
        load();
      }
    });
    es.addEventListener("end", () => {
      setLive(null);
      load();
      onChange();
      es.close();
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, watch]);

  // a run started elsewhere (CLI) has no live stream here: poll while it is running
  const runningElsewhere = !live && d?.run?.status === "running";
  useEffect(() => {
    if (!runningElsewhere) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningElsewhere]);

  if (err) return <div className="empty">{err}</div>;
  if (!d) return <div className="empty muted">Laden…</div>;
  const run = live ?? d.run;
  const a = d.answer;
  const tb = d.model?.title_block;

  return (
    <div className="project">
      <div className="row between wrap">
        <div>
          <h2 className="title">
            {tb?.drawing_number ?? project} <span className="muted">— {tb?.title ?? run?.source}</span>
          </h2>
          <div className="small muted">
            output/{project} · bron <code>{run?.source}</code>
            {run && <> · gestart {new Date(run.started_at).toLocaleString("nl-NL")}</>}
          </div>
        </div>
        <div className="row">
          {d.runs.length > 0 && (
            <span className="small muted">
              run {d.runs.find((r) => r.active)?.n ?? "—"} van {d.runs.length}
            </span>
          )}
          {run && run.status !== "running" && (
            <button onClick={() => setTab("Runs")} title="Lees de tekening opnieuw, met de open punten en de overlay als aanwijzingen">
              Opnieuw draaien…
            </button>
          )}
          {run && <StatusDot status={run.status} />}
        </div>
      </div>

      {run && <PipelineGraph run={run} />}
      {run?.error && <div className="banner">{run.error}</div>}

      <div className="cards">
        <Stat label="Apparatuur" value={a?.equipment_count} />
        <Stat label="Instrumenten" value={a?.instrument_count} />
        <Stat label="Kleppen" value={a?.valve_count} />
        <Stat label="Leidingen" value={a?.line_count} />
        <Stat label="Op de PDF" value={d.overlay?.vector ? pct(d.overlay.precision) : undefined} sub={d.overlay?.vector ? `leiding gevolgd ${pct(d.overlay.pipeRecall)}` : undefined} />
        <Stat label="Audit-score" value={a ? a.confidence.toFixed(2) : run?.score?.toFixed(2)} />
        <Stat label="Kosten" value={run ? `$${run.usage.cost_usd.toFixed(2)}` : undefined} sub={run ? `${run.usage.calls} calls` : undefined} />
      </div>

      {tb && (
        <dl className="titleblock">
          {(
            [
              ["Tekeningnummer", tb.drawing_number],
              ["Revisie", tb.revision],
              ["Blad", tb.sheet],
              ["Unit", tb.unit],
              ["Plant", tb.plant],
              ["Projectnr.", tb.project_number],
              ["Maker", tb.author],
              ["Datum", tb.date],
              ["Norm", d.model?.standard],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={v ? "" : "muted"}>{v ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "Open punten" && a ? <span className="badge">{a.unresolved.length}</span> : null}
            {t === "Runs" && d.runs.length > 1 ? <span className="badge">{d.runs.length}</span> : null}
          </button>
        ))}
      </nav>

      <section className="tabbody">
        {tab === "Tekening" && (d.model ? <DrawingView project={project} model={d.model} /> : <p className="muted">Nog geen gelezen items.</p>)}
        {tab === "Tabellen" && <TablesView project={project} ready={Boolean(d.files.find((f) => f.path.endsWith("pid.sqlite")))} />}
        {tab === "Open punten" && (
          <ul className="issues">
            {(a?.unresolved ?? d.model?.ambiguities ?? []).map((u, k) => (
              <li key={k}>
                <strong>{u.tag}</strong> — {u.issue}
              </li>
            ))}
          </ul>
        )}
        {tab === "DEXPI" &&
          (d.dexpi ? (
            <div>
              <p>
                <a className="button" href={api.fileUrl(project, `${project}.dexpi.xml`)} download>
                  Download {project}.dexpi.xml
                </a>{" "}
                <span className="small muted">DEXPI 2.0.1: procesmodel (Core/Plant) plus tekeninglaag (Core/Diagram) op de posities uit de PDF.</span>
              </p>
              {d.files.some((f) => f.path === `${project}.dexpi.svg`) && (
                <figure className="dexpi-preview">
                  <a href={api.fileUrl(project, `${project}.dexpi.svg`)} target="_blank" rel="noreferrer" title="Open op ware grootte">
                    <img src={api.fileUrl(project, `${project}.dexpi.svg`)} alt={`Tekeninglaag van ${project}.dexpi.xml`} />
                  </a>
                  <figcaption className="small muted">Tekeninglaag zoals die in het DEXPI-bestand staat (klik om te vergroten).</figcaption>
                </figure>
              )}
              <div className="cards">
                {Object.entries(d.dexpi.stats).map(([k, v]) => (
                  <Stat key={k} label={k.replace(/_/g, " ")} value={v} />
                ))}
              </div>
              <h4>Waarschuwingen ({d.dexpi.warnings.length})</h4>
              <ul className="issues">
                {d.dexpi.warnings.map((w, k) => (
                  <li key={k}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">DEXPI nog niet gegenereerd.</p>
          ))}
        {tab === "Overlay" && <OverlayView project={project} overlay={d.overlay} files={d.files} />}
        {tab === "Runs" && (
          <RunsView
            project={project}
            runs={d.runs}
            running={run?.status === "running"}
            onChange={() => {
              load();
              onChange();
              setWatch((w) => w + 1);
            }}
          />
        )}
        {tab === "Sleutel" && <KeyView project={project} />}
        {tab === "Log" && (
          <pre className="log">
            {(run?.log ?? []).map((l) => `${l.t.slice(11, 19)}  ${l.stage.padEnd(9)} ${l.msg}`).join("\n")}
          </pre>
        )}
        {tab === "Bestanden" && (
          <table className="data">
            <tbody>
              {d.files.map((f) => (
                <tr key={f.path}>
                  <td>
                    <a href={api.fileUrl(project, f.path)} target="_blank" rel="noreferrer">
                      {f.path}
                    </a>
                  </td>
                  <td className="num">{(f.bytes / 1024).toFixed(1)} kB</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

function Stat({ label, value, sub }: { label: string; value: unknown; sub?: string }) {
  return (
    <div className="card stat">
      <div className="small muted">{label}</div>
      <div className="big">{value === undefined || value === null ? "—" : String(value)}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}
