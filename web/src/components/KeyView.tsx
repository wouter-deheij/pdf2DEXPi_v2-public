import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AnswerKey, type Score } from "../api";
import type { KeyItem, KeyLink, KeyStatus } from "../../../server/pipeline/answerkey";
import type { BBox, Category } from "../../../server/types";

const CATS: [Category, string][] = [
  ["equipment", "Apparatuur"],
  ["instrument", "Instrumenten"],
  ["valve", "Kleppen"],
  ["piping_component", "Leidingcomponenten"],
  ["off_page", "Off-page"],
];
const STATUS: Record<KeyStatus, string> = {
  unchecked: "Nog niet gecontroleerd",
  ok: "Klopt",
  fixed: "Gecorrigeerd",
  added: "Toegevoegd (ontbrak)",
  rejected: "Staat niet op de tekening",
};
type Filter = "all" | "open" | "done" | "rejected";

/**
 * Answer-key review: every item of the draft key on the drawing; mark it right (K), not on the
 * drawing (X), correct its fields, add what is missing by dragging a box, and check the links.
 */
export default function KeyView({ project }: { project: string }) {
  const [key, setKey] = useState<AnswerKey | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [page, setPage] = useState(1);
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(CATS.map(([c]) => [c, true])));
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.5);
  const [mode, setMode] = useState<"select" | "add" | "link">("select");
  const [linkKind, setLinkKind] = useState<KeyLink["kind"]>("measures");
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [score, setScore] = useState<Score | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.key(project).then(setKey).catch((e) => setErr(e.message));
  }, [project]);

  // autosave shortly after every change
  const update = useCallback((fn: (k: AnswerKey) => AnswerKey) => {
    setKey((k) => {
      if (!k) return k;
      const next = fn(k);
      setSaved("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setSaved("saving");
        api.saveKey(next).then(() => setSaved("saved")).catch((e) => setErr(e.message));
      }, 700);
      return next;
    });
  }, []);

  const p = key?.pages.find((x) => x.n === page) ?? key?.pages[0];
  const [W, H] = p?.px ?? [1, 1];
  const item = key?.items.find((i) => i.key === sel) ?? null;
  const done = (s: KeyStatus) => s !== "unchecked";

  const visible = useMemo(() => {
    if (!key || !p) return [];
    return key.items.filter(
      (i) =>
        i.page === p.n &&
        on[i.category] &&
        (filter === "all" || (filter === "open" && i.status === "unchecked") || (filter === "done" && done(i.status) && i.status !== "rejected") || (filter === "rejected" && i.status === "rejected")) &&
        (!q || `${i.tag ?? ""} ${i.type} ${i.key}`.toLowerCase().includes(q.toLowerCase())),
    );
  }, [key, p, on, filter, q]);

  // reading order: rows of the sheet, left to right
  const order = useMemo(() => (key ? [...key.items].sort((a, b) => a.page - b.page || Math.floor(a.bbox[1] / 250) - Math.floor(b.bbox[1] / 250) || a.bbox[0] - b.bbox[0]) : []), [key]);

  const focus = useCallback(
    (k: KeyItem) => {
      setSel(k.key);
      setPage(k.page);
      const el = scroller.current;
      if (!el) return;
      requestAnimationFrame(() => {
        const cw = el.scrollWidth, ch = el.scrollHeight;
        el.scrollTo({ left: ((k.bbox[0] + k.bbox[2]) / 2 / W) * cw - el.clientWidth / 2, top: ((k.bbox[1] + k.bbox[3]) / 2 / H) * ch - el.clientHeight / 2, behavior: "smooth" });
      });
    },
    [W, H],
  );
  const nextOpen = useCallback(() => {
    if (!key) return;
    const start = sel ? order.findIndex((i) => i.key === sel) : -1;
    const rest = [...order.slice(start + 1), ...order.slice(0, start + 1)];
    const n = rest.find((i) => i.status === "unchecked" && on[i.category]);
    if (n) focus(n);
  }, [key, order, sel, on, focus]);

  const setItem = (k: string, patch: Partial<KeyItem>) => update((x) => ({ ...x, items: x.items.map((i) => (i.key === k ? { ...i, ...patch } : i)) }));
  const edit = (patch: Partial<KeyItem>) => item && setItem(item.key, { ...patch, status: item.status === "added" ? "added" : "fixed" });
  const mark = (status: KeyStatus, advance = true) => {
    if (!item) return;
    setItem(item.key, { status: status === "ok" && item.status === "added" ? "added" : status });
    if (advance) nextOpen();
  };
  const setLink = (id: string, status: KeyStatus) => update((x) => ({ ...x, links: x.links.map((l) => (l.id === id ? { ...l, status } : l)) }));

  // keyboard: K = klopt, X = staat er niet, N = volgende open
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === "k" || e.key === "K") mark("ok");
      else if (e.key === "x" || e.key === "X") mark("rejected");
      else if (e.key === "n" || e.key === "N") nextOpen();
      else if (e.key === "Escape") setMode("select");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const toPage = (e: React.MouseEvent) => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return [pt.x, pt.y];
  };
  const onDown = (e: React.MouseEvent) => {
    if (mode !== "add") return;
    const [x, y] = toPage(e);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const [x, y] = toPage(e);
    setDrag({ ...drag, x1: x, y1: y });
  };
  const onUp = () => {
    if (!drag || !key || !p) return;
    const b = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)].map(Math.round) as BBox;
    setDrag(null);
    if (b[2] - b[0] < 6 || b[3] - b[1] < 6) return;
    let n = key.items.filter((i) => i.key.startsWith("KEY-")).length + 1;
    while (key.items.some((i) => i.key === `KEY-${String(n).padStart(3, "0")}`)) n++;
    const k: KeyItem = { key: `KEY-${String(n).padStart(3, "0")}`, page: p.n, tag: null, category: "instrument", type: "", dexpi_class: null, bbox: b, status: "added" };
    update((x) => ({ ...x, items: [...x.items, k] }));
    setSel(k.key);
    setMode("select");
  };
  const clickBox = (k: KeyItem) => {
    if (mode === "link" && item && k.key !== item.key) {
      const l: KeyLink = { id: `S${Date.now().toString(36)}`, instrument: item.key, kind: linkKind, target: { item: k.key }, status: "added" };
      update((x) => ({ ...x, links: [...x.links, l] }));
      setMode("select");
      return;
    }
    setSel(k.key);
  };

  if (err) return <div className="banner">{err}</div>;
  if (key === undefined) return <p className="muted">Laden…</p>;
  if (key === null)
    return (
      <div>
        <p>Er is nog geen antwoordsleutel voor dit project.</p>
        <p className="small muted">Een concept wordt gemaakt uit de huidige uitlezing. Daarna controleer je elk item tegen de tekening: klopt het, corrigeer het, of staat het er niet. Wat ontbreekt voeg je toe door een kader te slepen.</p>
        <button className="button" onClick={() => api.draftKey(project).then(setKey).catch((e) => setErr(e.message))}>
          Concept maken uit huidige uitlezing
        </button>
      </div>
    );

  const total = key.items.length, checked = key.items.filter((i) => done(i.status)).length;
  const myLinks = item ? key.links.filter((l) => l.instrument === item.key || ("item" in l.target && l.target.item === item.key)) : [];
  const name = (k: string) => {
    const i = key.items.find((x) => x.key === k);
    return i ? i.tag ?? `${i.type || i.category} (${i.key})` : k;
  };
  const lnk = (l: KeyLink) => ("item" in l.target ? name(l.target.item) : `leiding via ${l.target.run.slice(0, 3).map(name).join(", ")}${l.target.run.length > 3 ? " …" : ""}`);

  return (
    <div className="drawing keyview">
      <div className="toolbar row wrap">
        {key.pages.length > 1 && (
          <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
            {key.pages.map((x) => (
              <option key={x.n} value={x.n}>
                Pagina {x.n}
              </option>
            ))}
          </select>
        )}
        {CATS.map(([c, label]) => (
          <label key={c} className={`chip cat-${c}`}>
            <input type="checkbox" checked={on[c]} onChange={(e) => setOn({ ...on, [c]: e.target.checked })} />
            {label}
          </label>
        ))}
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter op status">
          <option value="all">Alle items</option>
          <option value="open">Nog te controleren</option>
          <option value="done">Gecontroleerd</option>
          <option value="rejected">Afgewezen</option>
        </select>
        <input className="search" placeholder="Zoek tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="row">
          <button onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <span className="small muted">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>+</button>
        </span>
      </div>
      <div className="toolbar row wrap">
        <div className="progress" title={`${checked} van ${total} items gecontroleerd`}>
          <div style={{ width: `${(checked / Math.max(1, total)) * 100}%` }} />
        </div>
        <span className="small">
          {checked} / {total} items gecontroleerd
        </span>
        <button onClick={nextOpen}>Volgende open (N)</button>
        <button className={mode === "add" ? "active" : ""} onClick={() => setMode(mode === "add" ? "select" : "add")}>
          {mode === "add" ? "Sleep een kader op de tekening… (Esc)" : "+ Ontbrekend item"}
        </button>
        <button
          onClick={() => {
            const open = visible.filter((i) => i.status === "unchecked");
            if (open.length && confirm(`${open.length} zichtbare, nog niet gecontroleerde items als "klopt" markeren?`)) update((x) => ({ ...x, items: x.items.map((i) => (open.includes(i) ? { ...i, status: "ok" } : i)) }));
          }}
        >
          Zichtbare als klopt
        </button>
        <button onClick={() => api.score(project).then(setScore).catch((e) => setErr(e.message))}>Score huidige uitlezing</button>
        <span className={`small ${saved === "saved" ? "muted" : ""}`}>{saved === "saved" ? "Opgeslagen" : saved === "saving" ? "Opslaan…" : "Wijzigingen…"}</span>
      </div>

      {score && <ScoreCard s={score} onClose={() => setScore(null)} />}

      <div className="drawing-body">
        <div className="canvas-scroll" ref={scroller}>
          <div className="canvas" style={{ width: `${zoom * 100}%`, aspectRatio: `${W} / ${H}` }}>
            <img src={api.fileUrl(project, `pages/page-${p!.n}.preview.jpg`)} alt={`pagina ${p!.n}`} />
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`mode-${mode}`} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}>
              {visible.map((i) => (
                <g key={i.key} className={`kbox st-${i.status} cat-${i.category} ${sel === i.key ? "sel" : ""}`} onClick={() => clickBox(i)}>
                  <rect x={i.bbox[0]} y={i.bbox[1]} width={Math.max(8, i.bbox[2] - i.bbox[0])} height={Math.max(8, i.bbox[3] - i.bbox[1])} />
                  {i.status === "rejected" && <path d={`M${i.bbox[0]},${i.bbox[1]}L${i.bbox[2]},${i.bbox[3]}M${i.bbox[2]},${i.bbox[1]}L${i.bbox[0]},${i.bbox[3]}`} />}
                  <title>{`${i.tag ?? "(geen tag)"} · ${i.category} · ${STATUS[i.status]}`}</title>
                </g>
              ))}
              {drag && <rect className="drag" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} />}
            </svg>
          </div>
        </div>

        <aside className="inspector">
          {item ? (
            <>
              <h4>
                {item.tag ?? <span className="muted">(geen tag)</span>} <span className={`pill st-${item.status}`}>{STATUS[item.status]}</span>
              </h4>
              <div className="row wrap">
                <button className="ok" onClick={() => mark("ok")} title="Sneltoets K">
                  ✓ Klopt (K)
                </button>
                <button className="bad" onClick={() => mark("rejected")} title="Sneltoets X">
                  ✗ Staat er niet (X)
                </button>
                {item.status !== "unchecked" && item.status !== "added" && (
                  <button onClick={() => mark("unchecked", false)} title="Terug naar nog niet gecontroleerd">
                    ↺
                  </button>
                )}
                {item.status === "added" && (
                  <button
                    className="bad"
                    onClick={() => {
                      update((x) => ({ ...x, items: x.items.filter((i) => i.key !== item.key), links: x.links.filter((l) => l.instrument !== item.key && !("item" in l.target && l.target.item === item.key)) }));
                      setSel(null);
                    }}
                  >
                    Verwijderen
                  </button>
                )}
              </div>
              <label className="field">
                Tag
                <input value={item.tag ?? ""} placeholder="(geen tag)" onChange={(e) => edit({ tag: e.target.value || null })} />
              </label>
              <label className="field">
                Categorie
                <select value={item.category} onChange={(e) => edit({ category: e.target.value as Category })}>
                  {CATS.map(([c, l]) => (
                    <option key={c} value={c}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Type
                <input value={item.type} onChange={(e) => edit({ type: e.target.value })} />
              </label>
              <label className="field">
                DEXPI-klasse
                <input value={item.dexpi_class ?? ""} placeholder="—" onChange={(e) => edit({ dexpi_class: e.target.value || null })} />
              </label>
              <label className="field">
                Notitie
                <input value={item.note ?? ""} onChange={(e) => setItem(item.key, { note: e.target.value || undefined })} />
              </label>

              <h5>Koppelingen</h5>
              {myLinks.length ? (
                <ul className="links">
                  {myLinks.map((l) => (
                    <li key={l.id} className={`st-${l.status}`}>
                      <span>
                        {l.instrument === item.key ? (
                          <>
                            {l.kind} → {lnk(l)}
                          </>
                        ) : (
                          <>
                            ← {name(l.instrument)} ({l.kind})
                          </>
                        )}
                      </span>
                      <span className="row">
                        <button className="mini ok" onClick={() => setLink(l.id, l.status === "added" ? "added" : "ok")} title="Klopt">
                          ✓
                        </button>
                        <button className="mini bad" onClick={() => setLink(l.id, "rejected")} title="Klopt niet">
                          ✗
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">Geen koppelingen.</p>
              )}
              {item.category === "instrument" && (
                <div className="row wrap">
                  <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as KeyLink["kind"])} aria-label="Soort koppeling">
                    <option value="measures">meet</option>
                    <option value="actuates">stuurt aan</option>
                    <option value="signal">signaal naar</option>
                  </select>
                  <button className={mode === "link" ? "active" : ""} onClick={() => setMode(mode === "link" ? "select" : "link")}>
                    {mode === "link" ? "Klik het doel op de tekening… (Esc)" : "+ Koppeling"}
                  </button>
                </div>
              )}
              <p className="small muted">Een leiding als doel: klik een klep of component op die leiding.</p>
            </>
          ) : (
            <p className="muted small">
              Klik een kader, of begin met <strong>Volgende open (N)</strong>. Per item: <strong>K</strong> = klopt, <strong>X</strong> = staat niet op de tekening, of pas de velden aan. Ontbreekt er iets? Kies <strong>+ Ontbrekend item</strong> en sleep een kader.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function ScoreCard({ s, onClose }: { s: Score; onClose: () => void }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="scorecard">
      <div className="row between">
        <strong>Score van de huidige uitlezing tegen de sleutel</strong>
        <button className="mini" onClick={onClose}>
          ✕
        </button>
      </div>
      {s.reviewed < 1 && <p className="small muted">Sleutel voor {pct(s.reviewed)} gecontroleerd: nog niet gecontroleerde items tellen voorlopig als goed.</p>}
      <div className="cards">
        <div className="card stat">
          <div className="small muted">Items gevonden (recall)</div>
          <div className="big">{pct(s.items.recall)}</div>
          <div className="small muted">{s.items.fn} gemist</div>
        </div>
        <div className="card stat">
          <div className="small muted">Items juist (precisie)</div>
          <div className="big">{pct(s.items.precision)}</div>
          <div className="small muted">{s.items.fp} te veel</div>
        </div>
        <div className="card stat">
          <div className="small muted">Goed gelezen</div>
          <div className="big">{pct(s.attributes.tag / Math.max(1, s.attributes.matched))}</div>
          <div className="small muted">tag; klasse {pct(s.attributes.dexpi_class / Math.max(1, s.attributes.matched))}</div>
        </div>
        <div className="card stat">
          <div className="small muted">Koppelingen</div>
          <div className="big">{pct(s.links.f1)}</div>
          <div className="small muted">
            {s.links.fn} gemist, {s.links.fp} te veel
          </div>
        </div>
      </div>
      {s.missed.length > 0 && (
        <details>
          <summary>Gemist ({s.missed.length})</summary>
          <p className="small">{s.missed.join("; ")}</p>
        </details>
      )}
      {s.extra.length > 0 && (
        <details>
          <summary>Te veel ({s.extra.length})</summary>
          <p className="small">{s.extra.join("; ")}</p>
        </details>
      )}
      {s.wrong.length > 0 && (
        <details>
          <summary>Anders gelezen ({s.wrong.length})</summary>
          <ul className="small">
            {s.wrong.map((w, k) => (
              <li key={k}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
