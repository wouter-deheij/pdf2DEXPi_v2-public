import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const ORDER = ["equipment", "instruments", "valves", "piping_components", "off_page_connectors", "lines", "line_components", "signals", "unresolved", "drawing"];

/** Browse the project's SQLite tables (read-only), with filter and sort. */
export default function TablesView({ project, ready }: { project: string; ready: boolean }) {
  const [tables, setTables] = useState<string[]>([]);
  const [t, setT] = useState("equipment");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);

  useEffect(() => {
    if (!ready) return;
    api
      .table(project, t)
      .then((r) => {
        setTables(r.tables.sort((a, b) => (ORDER.indexOf(a) + 99) % 99 - (ORDER.indexOf(b) + 99) % 99));
        setRows(r.rows);
      })
      .catch(() => setRows([]));
  }, [project, t, ready]);

  const cols = rows[0] ? Object.keys(rows[0]).filter((c) => !["x0", "y0", "x1", "y1"].includes(c)) : [];
  const shown = useMemo(() => {
    let r = q ? rows.filter((x) => Object.values(x).some((v) => String(v ?? "").toLowerCase().includes(q.toLowerCase()))) : rows;
    if (sort) r = [...r].sort((a, b) => (String(a[sort.col] ?? "") > String(b[sort.col] ?? "") ? sort.dir : -sort.dir));
    return r;
  }, [rows, q, sort]);

  if (!ready) return <p className="muted">De tabellen verschijnen na de stap ‘Land tables & databases’.</p>;
  const csv = `tables/${t}.csv`;
  return (
    <div>
      <div className="toolbar row wrap">
        {tables.map((x) => (
          <button key={x} className={x === t ? "chip active" : "chip"} onClick={() => setT(x)}>
            {x}
          </button>
        ))}
      </div>
      <div className="toolbar row wrap">
        <input className="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small muted">
          {shown.length} van {rows.length} rijen
        </span>
        <a className="small" href={api.fileUrl(project, csv)} download>
          CSV
        </a>
        <a className="small" href={api.fileUrl(project, "database/pid.sqlite")} download>
          pid.sqlite
        </a>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} onClick={() => setSort(sort?.col === c ? { col: c, dir: sort.dir === 1 ? -1 : 1 } : { col: c, dir: 1 })}>
                  {c}
                  {sort?.col === c ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, k) => (
              <tr key={k}>
                {cols.map((c) => (
                  <td key={c} className={typeof r[c] === "number" ? "num" : ""}>
                    {r[c] === null || r[c] === undefined ? <span className="muted">—</span> : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
