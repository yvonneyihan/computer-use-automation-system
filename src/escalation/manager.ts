import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Controller = "agent" | "human";

export interface InterventionContext {
  capability: string;
  stepIndex: number;
  reason: string;
}

export interface InterventionRequest extends InterventionContext {
  id: string;
  runDir: string;
  status: "pending" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  humanActionsSummary?: string;
}

const POLL_INTERVAL_MS = 1000;

/**
 * Implements the pause / cede-control / resume seam over a live session. The browser
 * window stays open and untouched (see PlaywrightSurface — same Page, non-headless) while
 * this controller blocks the calling loop; a separate `operator` CLI process is the
 * (mocked) human-facing surface that signals resume via a file the two processes share.
 * The mechanism is real: it's the operator console UI, not the control transfer, that's
 * simplified for this project's scope.
 */
export class EscalationController {
  controller: Controller = "agent";

  constructor(private readonly runDir: string) {}

  private interventionPath(): string {
    return path.join(this.runDir, "intervention.json");
  }

  private resumeSignalPath(): string {
    return path.join(this.runDir, "resume.signal");
  }

  /** Raises an intervention request and blocks until the operator CLI signals resume. */
  async escalate(ctx: InterventionContext): Promise<{ humanActionsSummary: string }> {
    this.controller = "human";
    const request: InterventionRequest = {
      ...ctx,
      id: randomUUID(),
      runDir: this.runDir,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.interventionPath(), JSON.stringify(request, null, 2), "utf-8");

    const runId = path.basename(this.runDir);
    console.log("\n=== HUMAN INTERVENTION REQUESTED ===");
    console.log(`Reason: ${ctx.reason}`);
    console.log(`Step: ${ctx.stepIndex} | Capability/goal: ${ctx.capability}`);
    console.log(`Run: ${this.runDir}`);
    console.log(`The live browser window is still open — you may interact with it directly.`);
    console.log(`In another terminal: npm run operator -- --run ${runId}`);
    console.log("Waiting for the operator to resolve and hand control back...\n");

    const humanActionsSummary = await this.waitForResume();
    this.controller = "agent";
    return { humanActionsSummary };
  }

  private waitForResume(): Promise<string> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        if (existsSync(this.resumeSignalPath())) {
          const summary = readFileSync(this.resumeSignalPath(), "utf-8").trim();
          resolve(summary || "(no summary provided)");
          return true;
        }
        return false;
      };
      if (check()) return;
      const interval = setInterval(() => {
        if (check()) clearInterval(interval);
      }, POLL_INTERVAL_MS);
    });
  }
}
