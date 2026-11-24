import { useEffect, useRef, useState } from "react";
import { api, type RunSettings } from "../api";

const DEFAULTS: RunSettings = { standard: "auto", depth: "verified", tag_language: "as-printed", effort: "medium" };

export default function NewRun({ onStarted }: { onStarted: (project: string) => void }) {
  const [inputs, setInputs] = useState<{ file: string; bytes: number; project: string }[]>([]);
  const [file, setFile] = useState("");
  const [s, setS] = useState<RunSettings>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const upRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api.inputs().then((l) => {
      setInputs(l);
      setFile((f) => f || l[0]?.file || "");
    });
  useEffect(() => {
    load();
  }, []);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      const r = await api.upload(f);
      await load();
      setFile(r.file);
      setMsg(`Geüpload naar input/${r.file}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.run(file, s);
      onStarted(r.project);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof RunSettings>(k: K) => (e: React.ChangeEvent<HTMLSelectElement>) => setS({ ...s, [k]: e.target.value as RunSettings[K] });

  return (
    <div className="card newrun">
      <h3 className="section-title">Nieuwe run</h3>
      <label>
        Tekening (input/)
        <select value={file} onChange={(e) => setFile(e.target.value)}>
          {inputs.map((i) => (
            <option key={i.file} value={i.file}>
              {i.file} ({(i.bytes / 1024).toFixed(0)} kB)
            </option>
          ))}
        </select>
      </label>
      <div
        className="drop"
        onClick={() => upRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) upload(f);
        }}
      >
        Sleep een PDF hierheen of klik om te uploaden
        <input ref={upRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      <div className="grid2">
        <label>
          Symboolnorm
          <select value={s.standard} onChange={set("standard")}>
            <option value="auto">Automatisch</option>
            <option value="american">ISA / ANSI</option>
            <option value="german">DIN</option>
            <option value="iso">ISO 10628</option>
            <option value="dutch">NEN</option>
            <option value="british">BS</option>
            <option value="french">NF</option>
          </select>
        </label>
        <label>
          Controle
          <select value={s.depth} onChange={set("depth")}>
            <option value="fast">Snel — geen audit</option>
            <option value="verified">Gecontroleerd — 1 audit</option>
            <option value="exhaustive">Grondig — tot 4 audits</option>
          </select>
        </label>
        <label>
          Leesinspanning
          <select value={s.effort} onChange={set("effort")}>
            <option value="low">Laag (goedkoop)</option>
            <option value="medium">Middel</option>
            <option value="high">Hoog</option>
          </select>
        </label>
        <label>
          Tags
          <select value={s.tag_language} onChange={set("tag_language")}>
            <option value="as-printed">Zoals gedrukt</option>
            <option value="transliterate">Translitereren</option>
          </select>
        </label>
      </div>
      <button className="primary" disabled={!file || busy} onClick={start}>
        {busy ? "Bezig…" : "Start pipeline"}
      </button>
      <p className="small muted">Een A2/A3-blad kost circa 25–40 model-calls; de kosten staan per run in het project.</p>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
