import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { RunSettings, RunState, StageId } from "../types.ts";

/** Everything a stage needs: where to write, the settings, and how to report. */
export class RunContext {
  readonly events = new EventEmitter();
  /** Free-form scratch space shared between stages (page images, models…). */
  readonly bag: Record<string, unknown> = {};

  constructor(
    readonly dir: string,
    readonly settings: RunSettings,
    readonly state: RunState,
  ) {}

  path(...p: string[]) {
    return path.join(this.dir, ...p);
  }

  ensureDir(...p: string[]) {
    const d = this.path(...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  writeJSON(rel: string, data: unknown) {
    const file = this.path(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  writeText(rel: string, text: string | Buffer) {
    const file = this.path(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  log(stage: StageId | "run", msg: string) {
    const entry = { t: new Date().toISOString(), stage, msg };
    this.state.log.push(entry);
    console.log(`[${this.state.project}] ${stage}: ${msg}`);
    this.persist();
    this.events.emit("update", this.state);
  }

  persist() {
    this.writeJSON("run.json", this.state);
  }
}
