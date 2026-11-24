import { useMemo, useState } from "react";
import { api, type DrawingModel } from "../api";
import type { Item } from "../../../server/types";

const CATS = [
  ["equipment", "Apparatuur"],
  ["instrument", "Instrumenten"],
  ["valve", "Kleppen"],
  ["piping_component", "Leidingcomponenten"],
  ["off_page", "Off-page"],
] as const;

/** Page image with every read item drawn on top; click an item to see what was read. */
export default function DrawingView({ project, model }: { project: string; model: DrawingModel }) {
  const [page, setPage] = useState(1);
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(CATS.map(([c]) => [c, true])));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Item | null>(null);
  const [zoom, setZoom] = useState(1);
  const p = model.pages.find((x) => x.n === page) ?? model.pages[0];
  const [W, H] = p.px;

  const items = useMemo(
    () =>
      model.items.filter(
        (i) => i.page === p.n && on[i.category] && (!q || `${i.tag ?? ""} ${i.type} ${i.description ?? ""} ${i.id}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [model, p.n, on, q],
  );
  const lineOf = (id: string) => model.lines.find((l) => l.components.includes(id));

  return (
    <div className="drawing">
      <div className="toolbar row wrap">
        {model.pages.length > 1 && (
          <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
            {model.pages.map((x) => (
              <option key={x.n} value={x.n}>
                Pagina {x.n}
              </option>
            ))}
          </select>
        )}
        {CATS.map(([c, label]) => (
          <label key={c} className={`chip cat-${c}`}>
            <input type="checkbox" checked={on[c]} onChange={(e) => setOn({ ...on, [c]: e.target.checked })} />
            {label} ({model.items.filter((i) => i.category === c && i.page === p.n).length})
          </label>
        ))}
        <input className="search" placeholder="Zoek tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="row">
          <button onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <span className="small muted">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(6, z * 1.5))}>+</button>
        </span>
      </div>
      <div className="drawing-body">
        <div className="canvas-scroll">
          <div className="canvas" style={{ width: `${zoom * 100}%`, aspectRatio: `${W} / ${H}` }}>
            <img src={api.fileUrl(project, `pages/page-${p.n}.preview.jpg`)} alt={`pagina ${p.n}`} />
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {items.map((i) => (
                <g key={i.id} className={`box cat-${i.category} ${sel?.id === i.id ? "sel" : ""} ${i.confidence < 0.7 ? "low" : ""}`} onClick={() => setSel(i)}>
                  <rect x={i.bbox[0]} y={i.bbox[1]} width={Math.max(8, i.bbox[2] - i.bbox[0])} height={Math.max(8, i.bbox[3] - i.bbox[1])} />
                  <title>{`${i.tag ?? "(geen tag)"} · ${i.type} · ${i.confidence}`}</title>
                </g>
              ))}
            </svg>
          </div>
        </div>
        <aside className="inspector">
          {sel ? (
            <>
              <h4>{sel.tag ?? <span className="muted">(geen tag)</span>}</h4>
              <dl>
                {(
                  [
                    ["id", sel.id],
                    ["categorie", sel.category],
                    ["type", sel.type],
                    ["DEXPI-klasse", sel.dexpi_class],
                    ["omschrijving", sel.description],
                    ["service", sel.service],
                    ["maat", sel.size],
                    ["leiding", lineOf(sel.id)?.line_id ?? lineOf(sel.id)?.id ?? sel.line_ref],
                    ["aandrijving", sel.actuator],
                    ["lus", sel.loop],
                    ["kleur", sel.color],
                    ["zekerheid", sel.confidence],
                    ["gezien in", sel.sources.join(", ")],
                    ["notitie", sel.note],
                  ] as const
                )
                  .filter(([, v]) => v !== null && v !== undefined && v !== "")
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </>
          ) : (
            <p className="muted small">Klik op een kader in de tekening. Gestippelde kaders hebben een zekerheid onder 0,7.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
