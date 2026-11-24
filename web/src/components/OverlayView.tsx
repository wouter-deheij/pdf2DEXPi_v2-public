import { api, type Overlay } from "../api";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);

/** How well the DEXPI drawing lies on the PDF: scores, the coloured overlay per page, largest misses. */
export default function OverlayView({ project, overlay, files }: { project: string; overlay: Overlay | null; files: { path: string; bytes: number }[] }) {
  if (!overlay) return <p className="muted">Nog geen overlay. Die komt na de DEXPI-stap (of met <code>npm run redexpi</code> / <code>npm run overlay</code>).</p>;
  if (!overlay.vector) return <p className="muted">Gescand blad: er is geen vectorlaag om de DEXPI-tekening mee te vergelijken.</p>;
  const pngs = files.filter((f) => /^overlay-p\d+\.png$/.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return (
    <div>
      <p className="small muted">
        Onze DEXPI-tekening teruggelegd op de getekende lijnen van de PDF (vectorlaag, zonder model-calls).
      </p>
      <div className="cards">
        <Card label="Op de tekening" value={pct(overlay.precision)} sub="van onze lijnen ligt op een getekende lijn" />
        <Card label="Leiding gevolgd" value={pct(overlay.pipeRecall)} sub="van de getekende doorgetrokken lijnen tekenen wij ook" />
        <Card label="Signaal gevolgd" value={pct(overlay.signalRecall)} sub="van de getekende gestreepte lijnen tekenen wij ook" />
      </div>
      <div className="legend small">
        <span><i style={{ background: "#18a058" }} /> onze lijn op de tekening</span>
        <span><i style={{ background: "#e5332a" }} /> onze lijn waar niets getekend is (verzonnen)</span>
        <span><i style={{ background: "#1f6fff" }} /> getekend maar niet door ons getekend (gemist)</span>
      </div>
      {pngs.map((f) => (
        <figure key={f.path} className="dexpi-preview">
          <a href={api.fileUrl(project, f.path)} target="_blank" rel="noreferrer" title="Open op ware grootte">
            <img src={`${api.fileUrl(project, f.path)}?v=${f.bytes}`} alt={`Overlay ${f.path}`} />
          </a>
          <figcaption className="small muted">{f.path} (klik om te vergroten)</figcaption>
        </figure>
      ))}
      <div className="row wrap" style={{ gap: 24, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>Grootste gemiste stukken</h4>
          <div className="scroll-x"><table className="data">
            <thead>
              <tr><th>blad</th><th className="num">lengte px</th><th>plek (x0,y0,x1,y1)</th><th>raakt</th></tr>
            </thead>
            <tbody>
              {overlay.misses.map((m, k) => (
                <tr key={k}><td>{m.page}</td><td className="num">{m.length}</td><td>{m.bbox.join(", ")}</td><td>{m.touches.join(", ")}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4>Grootste verzonnen stukken</h4>
          <div className="scroll-x"><table className="data">
            <thead>
              <tr><th>blad</th><th className="num">lengte px</th><th>soort</th><th>DEXPI-object</th></tr>
            </thead>
            <tbody>
              {overlay.extras.map((e, k) => (
                <tr key={k}><td>{e.page}</td><td className="num">{e.length}</td><td>{e.kind}</td><td>{e.id ?? "—"}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card stat">
      <div className="small muted">{label}</div>
      <div className="big">{value}</div>
      <div className="small muted">{sub}</div>
    </div>
  );
}
