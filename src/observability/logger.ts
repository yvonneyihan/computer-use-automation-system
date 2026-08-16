import { mkdirSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { redactObject } from "../safety/redact.js";

export type Actor = "system" | "agent" | "human" | "replay";

export interface LogEvent {
  ts: string;
  actor: Actor;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Structured, redacted evidence for a single run (discovery or replay). Everything
 * written here — the JSONL log, screenshots, aria snapshots, the intervention record,
 * and the final result — lives under /evidence/<runId>/ so a run can be understood and
 * debugged after the fact without re-running it.
 */
export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private readonly stream: WriteStream;

  constructor(kind: "discovery" | "replay", label: string, baseDir = "evidence") {
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "_");
    this.runId = `${kind}-${safeLabel}-${Date.now()}`;
    this.dir = path.resolve(process.cwd(), baseDir, this.runId);
    mkdirSync(path.join(this.dir, "screenshots"), { recursive: true });
    this.stream = createWriteStream(path.join(this.dir, "log.jsonl"), { flags: "a" });
  }

  log(actor: Actor, type: string, data: Record<string, unknown> = {}): void {
    const event: LogEvent = { ts: new Date().toISOString(), actor, type, data: redactObject(data) };
    this.stream.write(JSON.stringify(event) + "\n");
  }

  screenshotPath(label: string): string {
    return path.join(this.dir, "screenshots", `${label}.png`);
  }

  writeAriaSnapshot(label: string, content: string): void {
    writeFileSync(path.join(this.dir, `aria-${label}.txt`), content, "utf-8");
  }

  writeResult(result: unknown): void {
    writeFileSync(path.join(this.dir, "result.json"), JSON.stringify(redactObject(result), null, 2), "utf-8");
  }

  close(): void {
    this.stream.end();
  }
}
