import { STAGES } from "../../../server/types";
import type { RunState } from "../api";

const ICON: Record<string, string> = { pending: "○", running: "◌", done: "✓", failed: "✕", skipped: "–" };

/** The playbook stages as a horizontal flow, like the Corvic canvas. */
export default function PipelineGraph({ run }: { run: RunState }) {
  return (
    <div className="pipeline">
      {STAGES.map((st, k) => {
        const s = run.stages.find((x) => x.id === st.id);
        const status = s?.status ?? "pending";
        const lastLog = [...run.log].reverse().find((l) => l.stage === st.id);
        const dur = s?.started_at && s.finished_at ? Math.round((+new Date(s.finished_at) - +new Date(s.started_at)) / 1000) : null;
        return (
          <div key={st.id} className="stage-wrap">
            {k > 0 && <div className={`arrow ${status !== "pending" ? "lit" : ""}`} />}
            <div className={`stage stage-${status}`} title={s?.note ?? lastLog?.msg}>
              <div className="row between">
                <span className="stage-icon">{ICON[status]}</span>
                {dur !== null && <span className="small muted">{dur}s</span>}
              </div>
              <div className="stage-label">{st.label}</div>
              <div className="small muted">→ {st.produces.join(", ")}</div>
              {status === "running" && lastLog && <div className="small stage-msg ellipsis">{lastLog.msg}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
