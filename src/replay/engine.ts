import type { CapabilityArtifact, Checkpoint, Step } from "../artifact/schema.js";
import { LocatorNotFoundError, type Surface, type SurfaceAction } from "../surface/surface.js";
import { AllowlistPolicy, locatorToCandidateFields, type CandidateAction } from "../safety/allowlist.js";
import { redactValue } from "../safety/redact.js";
import type { RunLogger } from "../observability/logger.js";
import type { EscalationController } from "../escalation/manager.js";
import type { ReplayOutcome } from "./result.js";

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  surface: Surface;
  policy: AllowlistPolicy;
  logger: RunLogger;
  escalation: EscalationController;
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in params)) throw new Error(`Missing input parameter "${key}" required by this step.`);
    return params[key];
  });
}

function buildSurfaceAction(step: Step, params: Record<string, string>): SurfaceAction {
  switch (step.action) {
    case "click":
      return { type: "click", locator: step.locator! };
    case "type":
      return { type: "type", locator: step.locator!, text: interpolate(step.valueTemplate ?? "", params) };
    case "select":
      return { type: "select", locator: step.locator!, value: interpolate(step.valueTemplate ?? "", params) };
    case "navigate":
      return { type: "navigate", url: interpolate(step.valueTemplate ?? "", params) };
    case "wait_for":
      return { type: "wait_for", locator: step.locator! };
    case "extract":
      throw new Error("extract steps are executed via Surface.extract, not perform()");
  }
}

function candidateFromSurfaceAction(action: SurfaceAction): CandidateAction {
  if (action.type === "navigate") return { type: "navigate", url: action.url };
  const { locatorText, locatorTestId } = locatorToCandidateFields(action.locator);
  return { type: action.type, locatorText, locatorTestId };
}

async function verifyCheckpoint(surface: Surface, checkpoint: Checkpoint, timeoutMs = 5000): Promise<boolean> {
  switch (checkpoint.type) {
    case "urlMatches":
      return new RegExp(checkpoint.pattern).test(surface.currentUrl());
    case "elementVisible": {
      const res = await surface.resolveLocator(checkpoint.locator, timeoutMs);
      return res.found;
    }
    case "elementText": {
      const res = await surface.resolveLocator(checkpoint.locator, timeoutMs);
      if (!res.found) return false;
      const text = await surface.extract(checkpoint.locator);
      return new RegExp(checkpoint.pattern, "i").test(text);
    }
    case "elementCount": {
      const res = await surface.resolveLocator(checkpoint.locator, timeoutMs);
      return res.found && res.matchedCount === checkpoint.expectedCount;
    }
  }
}

/** Checks the artifact's declared outcomeChecks against current state — tried before any hard failure is reported. */
async function matchOutcomeCheck(artifact: CapabilityArtifact, surface: Surface) {
  for (const oc of artifact.outcomeChecks) {
    if (await verifyCheckpoint(surface, oc.checkpoint, 1500)) return oc;
  }
  return undefined;
}

async function captureFailureEvidence(surface: Surface, logger: RunLogger, label: string): Promise<string> {
  await surface.screenshot(logger.screenshotPath(label));
  const obs = await surface.observe();
  logger.writeAriaSnapshot(label, obs.ariaSnapshot);
  return logger.dir;
}

function redactParamsForLog(params: Record<string, string>, schema: CapabilityArtifact["inputSchema"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = schema[k]?.sensitive ? redactValue(v, k) : v;
  return out;
}

/**
 * Deterministic replay: no LLM in the loop. Fixed step sequence, ranked-locator
 * resolution, explicit checkpoints, and a result contract that separates business
 * outcomes from recoverable interstitials from hard failures — see REPORT.md,
 * "Determinism & error handling."
 */
export async function replayArtifact(opts: ReplayOptions): Promise<ReplayOutcome> {
  const { artifact, params, surface, policy, logger, escalation } = opts;

  for (const [key, field] of Object.entries(artifact.inputSchema)) {
    if (field.required && !(key in params)) {
      throw new Error(`Missing required input parameter: ${key}`);
    }
  }

  logger.log("system", "replay_start", {
    artifact: artifact.name,
    version: artifact.version,
    params: redactParamsForLog(params, artifact.inputSchema),
  });

  const outputs: Record<string, string> = {};

  for (const step of artifact.steps) {
    // Cross-cutting interstitials (e.g. a cookie banner) are dismissed before any step,
    // independent of what that step is trying to do.
    for (const entry of artifact.recoverySpec) {
      const res = await surface.resolveLocator(entry.trigger, 500);
      if (res.found) {
        logger.log("replay", "recovery_dismiss", { name: entry.name, step: step.index });
        await surface.perform({ type: "click", locator: entry.trigger });
      }
    }

    if (step.action !== "extract") {
      const action = buildSurfaceAction(step, params);
      const decision = policy.evaluate(candidateFromSurfaceAction(action), surface.currentUrl());
      if (!decision.allowed) {
        const evidenceRef = await captureFailureEvidence(surface, logger, `blocked-step-${step.index}`);
        logger.log("system", "policy_block", { step: step.index, reason: decision.reason });
        return { kind: "failure", stepIndex: step.index, expected: "an allowed action", observed: `blocked: ${decision.reason}`, message: decision.reason, evidenceRef };
      }

      try {
        await surface.perform(action);
        logger.log("replay", "action", { step: step.index, action: step.action, locator: step.locator });
      } catch (err) {
        const outcome = await matchOutcomeCheck(artifact, surface);
        if (outcome) {
          const evidenceRef = await captureFailureEvidence(surface, logger, `outcome-${outcome.name}-step-${step.index}`);
          logger.log("replay", "business_outcome", { outcome: outcome.name, step: step.index });
          return { kind: "business_outcome", outcome: outcome.name, description: outcome.description, evidenceRef };
        }

        const evidenceRef = await captureFailureEvidence(surface, logger, `failure-step-${step.index}`);
        const message = err instanceof LocatorNotFoundError ? err.message : String(err);
        logger.log("replay", "hard_failure", { step: step.index, error: message });

        const { humanActionsSummary } = await escalation.escalate({
          capability: artifact.name,
          stepIndex: step.index,
          reason: `Hard failure during replay: ${message}`,
        });
        logger.log("human", "resume", { humanActionsSummary });

        return {
          kind: "failure",
          stepIndex: step.index,
          expected: describeExpected(step),
          observed: message,
          message: `${message} (human notes: ${humanActionsSummary})`,
          evidenceRef,
        };
      }
    } else {
      try {
        const value = await surface.extract(step.locator!);
        outputs[step.outputKey!] = value;
        logger.log("replay", "extract", { step: step.index, outputKey: step.outputKey });
      } catch (err) {
        const outcome = await matchOutcomeCheck(artifact, surface);
        if (outcome) {
          const evidenceRef = await captureFailureEvidence(surface, logger, `outcome-${outcome.name}-step-${step.index}`);
          return { kind: "business_outcome", outcome: outcome.name, description: outcome.description, evidenceRef };
        }
        const evidenceRef = await captureFailureEvidence(surface, logger, `failure-step-${step.index}`);
        const message = err instanceof LocatorNotFoundError ? err.message : String(err);
        return { kind: "failure", stepIndex: step.index, expected: describeExpected(step), observed: message, message, evidenceRef };
      }
    }

    if (step.checkpoint) {
      const ok = await verifyCheckpoint(surface, step.checkpoint);
      if (!ok) {
        const outcome = await matchOutcomeCheck(artifact, surface);
        if (outcome) {
          const evidenceRef = await captureFailureEvidence(surface, logger, `outcome-${outcome.name}-step-${step.index}`);
          return { kind: "business_outcome", outcome: outcome.name, description: outcome.description, evidenceRef };
        }
        const evidenceRef = await captureFailureEvidence(surface, logger, `checkpoint-fail-step-${step.index}`);
        return {
          kind: "failure",
          stepIndex: step.index,
          expected: JSON.stringify(step.checkpoint),
          observed: (await surface.observe()).ariaSnapshot.slice(0, 500),
          message: "Step checkpoint was not satisfied.",
          evidenceRef,
        };
      }
    }
  }

  const finalOk = await verifyCheckpoint(surface, artifact.successCheckpoint);
  if (!finalOk) {
    const outcome = await matchOutcomeCheck(artifact, surface);
    if (outcome) {
      const evidenceRef = await captureFailureEvidence(surface, logger, `outcome-${outcome.name}-final`);
      logger.log("replay", "business_outcome", { outcome: outcome.name, step: "final" });
      return { kind: "business_outcome", outcome: outcome.name, description: outcome.description, evidenceRef };
    }
    const evidenceRef = await captureFailureEvidence(surface, logger, "checkpoint-fail-final");
    return {
      kind: "failure",
      stepIndex: artifact.steps.length,
      expected: JSON.stringify(artifact.successCheckpoint),
      observed: (await surface.observe()).ariaSnapshot.slice(0, 500),
      message: "Final success checkpoint was not satisfied.",
      evidenceRef,
    };
  }

  logger.log("replay", "success", { outputs });
  return { kind: "success", outputs, evidenceRef: logger.dir };
}

function describeExpected(step: Step): string {
  return `step ${step.index} (${step.action}): ${step.description}`;
}
