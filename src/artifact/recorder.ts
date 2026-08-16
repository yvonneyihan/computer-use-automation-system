import { randomUUID } from "node:crypto";
import type { CapabilityArtifact, Checkpoint, ParamField, Step } from "./schema.js";
import type { DiscoveryResult, TraceEntry } from "../agent/loop.js";

function stepFromTrace(t: TraceEntry): Step {
  const valueTemplate = t.paramName ? `{{${t.paramName}}}` : t.value;
  return {
    index: t.index,
    action: t.action,
    description: t.description,
    locator: t.locator,
    valueTemplate,
    outputKey: t.outputKey,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RecordArtifactOptions {
  name: string;
  description: string;
  appName: string;
  baseUrl: string;
  testIdAttribute: string;
  allowedDomains: string[];
  result: DiscoveryResult;
  /** Current URL at the moment the goal was declared complete — used as a checkpoint fallback. */
  finalUrl: string;
}

/** Converts a successful discovery trace into a versioned, reviewable capability artifact. */
export function recordArtifact(opts: RecordArtifactOptions): CapabilityArtifact {
  const steps = opts.result.trace.map(stepFromTrace);

  const inputSchema: Record<string, ParamField> = {};
  for (const t of opts.result.trace) {
    if (t.paramName && !inputSchema[t.paramName]) {
      inputSchema[t.paramName] = {
        type: "string",
        description: `Used in: ${t.description}`,
        required: true,
        sensitive: !!t.sensitive,
      };
    }
  }

  const outputSchema: Record<string, ParamField> = {};
  for (const t of opts.result.trace) {
    if (t.outputKey && !outputSchema[t.outputKey]) {
      outputSchema[t.outputKey] = { type: "string", description: `Extracted: ${t.description}`, required: true, sensitive: false };
    }
  }

  // Prefer the structured checkpoint the agent named when it called finish(); fall back to
  // asserting the final URL if the agent didn't supply (or mis-shaped) one.
  const successCheckpoint: Checkpoint = opts.result.successCheckpoint ?? {
    type: "urlMatches",
    pattern: escapeRegExp(opts.finalUrl),
  };

  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id: randomUUID(),
    name: opts.name,
    description: opts.description,
    version: 1,
    status: "draft",
    target: { app: opts.appName, baseUrl: opts.baseUrl, testIdAttribute: opts.testIdAttribute },
    createdAt: now,
    updatedAt: now,
    createdBy: "discovery-agent",
    inputSchema,
    outputSchema,
    steps,
    successCheckpoint,
    outcomeChecks: [],
    recoverySpec: [],
    policy: { allowedDomains: opts.allowedDomains, riskLevel: "safe" },
  };
}
