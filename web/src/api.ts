import type { Answer, DrawingModel, Profile, ProjectSummary, RunSettings, RunState } from "../../server/types";

import type { AnswerKey, Score } from "../../server/pipeline/answerkey";
import type { RunInfo } from "../../server/pipeline/runs";
export type { RunInfo };
export type { Answer, AnswerKey, DrawingModel, Profile, ProjectSummary, RunSettings, RunState, Score };

export interface Overlay {
  vector: boolean;
  precision: number | null;
  pipeRecall: number | null;
  signalRecall: number | null;
  pages: { n: number; precision: number | null; pipeRecall: number | null; signalRecall: number | null }[];
  misses: { page: number; bbox: [number, number, number, number]; length: number; touches: string[] }[];
  extras: { page: number; id: string | null; kind: string; length: number; bbox: [number, number, number, number] }[];
}

export interface ProjectDetail {
  run: RunState | null;
  profile: Profile | null;
  answer: Answer | null;
  model: DrawingModel | null;
  dexpi: { stats: Record<string, number>; warnings: string[] } | null;
  overlay: Overlay | null;
  files: { path: string; bytes: number }[];
  runs: RunInfo[];
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => j<{ ok: boolean; model: string; api_key: boolean }>(r)),
  inputs: () => fetch("/api/inputs").then((r) => j<{ file: string; bytes: number; project: string }[]>(r)),
  projects: () => fetch("/api/projects").then((r) => j<ProjectSummary[]>(r)),
  project: (p: string) => fetch(`/api/projects/${encodeURIComponent(p)}`).then((r) => j<ProjectDetail>(r)),
  table: (p: string, t: string) =>
    fetch(`/api/projects/${encodeURIComponent(p)}/table/${encodeURIComponent(t)}`).then((r) => j<{ tables: string[]; rows: Record<string, unknown>[] }>(r)),
  upload: (f: File) => {
    const fd = new FormData();
    fd.append("drawing", f);
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => j<{ file: string; project: string }>(r));
  },
  run: (file: string, settings: RunSettings) =>
    fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, settings }) }).then((r) =>
      j<{ project: string }>(r),
    ),
  rerunPreview: (p: string, notes: string) =>
    fetch(`/api/projects/${encodeURIComponent(p)}/rerun/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).then((r) =>
      j<{ text: string; points: number; overlay: number }>(r),
    ),
  rerun: (p: string, notes: string) =>
    fetch(`/api/projects/${encodeURIComponent(p)}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).then((r) => j<{ project: string }>(r)),
  correctPreview: (p: string, notes: string) =>
    fetch(`/api/projects/${encodeURIComponent(p)}/correct/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).then((r) =>
      j<{ points: { kind: string; text: string }[]; unplaced: string[] }>(r),
    ),
  correct: (p: string, notes: string) =>
    fetch(`/api/projects/${encodeURIComponent(p)}/correct`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).then((r) => j<{ project: string }>(r)),
  activateRun:(p: string, n: number) => fetch(`/api/projects/${encodeURIComponent(p)}/runs/${n}/activate`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  key: (p: string) => fetch(`/api/keys/${encodeURIComponent(p)}`).then((r) => (r.status === 404 ? null : j<AnswerKey>(r))),
  draftKey: (p: string) => fetch(`/api/keys/${encodeURIComponent(p)}/draft`, { method: "POST" }).then((r) => j<AnswerKey>(r)),
  saveKey: (k: AnswerKey) =>
    fetch(`/api/keys/${encodeURIComponent(k.project)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(k) }).then((r) => j<{ ok: boolean; updated: string }>(r)),
  score: (p: string) => fetch(`/api/keys/${encodeURIComponent(p)}/score`).then((r) => j<Score>(r)),
  fileUrl: (p: string, rel: string) => `/files/${encodeURIComponent(p)}/${rel.split("/").map(encodeURIComponent).join("/")}`,
};
