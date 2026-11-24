import { useCallback, useEffect, useState } from "react";
import { api, type ProjectSummary } from "./api";
import NewRun from "./components/NewRun";
import ProjectView from "./components/ProjectView";

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("p"));
  const [health, setHealth] = useState<{ model: string; api_key: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.projects().then(setProjects).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    api.health().then(setHealth).catch(() => setError("Server niet bereikbaar — draait `npm run dev`?"));
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const select = (p: string) => {
    setSelected(p);
    history.replaceState(null, "", `?p=${encodeURIComponent(p)}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">P&amp;ID</span>
          <span>→ DEXPI</span>
          <span className="muted small">PDF-tekening naar DEXPI 2.0.1, tabellen en database</span>
        </div>
        <div className="small muted">
          {health ? (
            <>
              model <code>{health.model}</code> · API-sleutel {health.api_key ? <span className="ok">gevonden</span> : <span className="bad">ontbreekt</span>}
            </>
          ) : (
            "…"
          )}
        </div>
      </header>
      {error && (
        <div className="banner" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="layout">
        <aside className="sidebar">
          <NewRun
            onStarted={(p) => {
              refresh();
              select(p);
            }}
          />
          <h3 className="section-title">Projecten</h3>
          {projects.length === 0 && <p className="muted small">Nog geen projecten in output/.</p>}
          <ul className="projects">
            {projects.map((p) => (
              <li key={p.project} className={p.project === selected ? "active" : ""} onClick={() => select(p.project)}>
                <div className="row between">
                  <strong className="ellipsis">{p.answer?.drawing_number ?? p.project}</strong>
                  <StatusDot status={p.status} />
                </div>
                <div className="small muted ellipsis">{p.answer?.drawing_title ?? p.source}</div>
                {p.answer && (
                  <div className="small muted">
                    {p.answer.equipment_count} eq · {p.answer.instrument_count} instr · {p.answer.valve_count} kleppen · {p.answer.line_count} lijnen
                  </div>
                )}
              </li>
            ))}
          </ul>
        </aside>
        <main className="main">
          {selected ? (
            <ProjectView key={selected} project={selected} onChange={refresh} />
          ) : (
            <div className="empty">
              <h2>Kies een P&amp;ID</h2>
              <p className="muted">
                Start links een run op een PDF uit <code>input/</code> of upload een nieuwe tekening. De pipeline leest de tekening in tegels met Claude,
                controleert het resultaat, volgt de leidingen en schrijft per project naar <code>output/&lt;project&gt;/</code>: DEXPI-XML, CSV-tabellen,
                een SQLite-database en het antwoord in de vaste vorm.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const label = { running: "bezig", done: "klaar", failed: "mislukt", unknown: "?" }[status] ?? status;
  return <span className={`status status-${status}`}>{label}</span>;
}
