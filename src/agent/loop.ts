import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { DISCOVERY_TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { LocatorNotFoundError, type Surface } from "../surface/surface.js";
import { AllowlistPolicy, locatorToCandidateFields, type CandidateAction } from "../safety/allowlist.js";
import type { RunLogger } from "../observability/logger.js";
import type { EscalationController } from "../escalation/manager.js";
import { CheckpointSchema, type Checkpoint, type ElementLocator, type StepActionType } from "../artifact/schema.js";

export interface TraceEntry {
  index: number;
  action: StepActionType;
  description: string;
  locator?: ElementLocator;
  /** Literal value actually used (type/select/navigate). Never populated for sensitive fields. */
  value?: string;
  paramName?: string;
  sensitive?: boolean;
  outputKey?: string;
  extractedValue?: string;
}

export interface DiscoveryResult {
  success: boolean;
  reason: string;
  trace: TraceEntry[];
  outputs: Record<string, string>;
  successCheckpoint?: Checkpoint;
}

export interface DiscoveryLoopOptions {
  goal: string;
  surface: Surface;
  policy: AllowlistPolicy;
  allowedDomains: string[];
  logger: RunLogger;
  escalation: EscalationController;
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
}

function toCandidateAction(name: string, input: Record<string, unknown>): CandidateAction {
  if (name === "navigate") return { type: "navigate", url: input.url as string };
  const { locatorText, locatorTestId } = locatorToCandidateFields(input.locator as ElementLocator | undefined);
  return { type: name as CandidateAction["type"], locatorText, locatorTestId };
}

/** Never let a secret's literal value reach a log line, regardless of the JSON field it arrived in. */
function sanitizeToolInputForLog(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((name === "type" || name === "select") && input.sensitive) {
    return { ...input, text: input.text !== undefined ? "***REDACTED***" : undefined, value: input.value !== undefined ? "***REDACTED***" : undefined };
  }
  return input;
}

function imageBlockFromFile(path: string): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: readFileSync(path).toString("base64") },
  };
}

async function captureObservation(surface: Surface, logger: RunLogger, label: string) {
  const obs = await surface.observe();
  const shotPath = logger.screenshotPath(label);
  await surface.screenshot(shotPath);
  return { obs, shotPath };
}

async function executeTool(name: string, input: Record<string, unknown>, surface: Surface, index: number): Promise<TraceEntry> {
  switch (name) {
    case "click": {
      const locator = input.locator as ElementLocator;
      await surface.perform({ type: "click", locator });
      return { index, action: "click", description: String(input.description), locator };
    }
    case "type": {
      const locator = input.locator as ElementLocator;
      const sensitive = !!input.sensitive;
      const paramName = (input.paramName as string | undefined) ?? (sensitive ? `secret_field_${index}` : undefined);
      await surface.perform({ type: "type", locator, text: String(input.text) });
      return {
        index,
        action: "type",
        description: String(input.description),
        locator,
        value: sensitive ? undefined : String(input.text),
        paramName,
        sensitive,
      };
    }
    case "select": {
      const locator = input.locator as ElementLocator;
      await surface.perform({ type: "select", locator, value: String(input.value) });
      return { index, action: "select", description: String(input.description), locator, value: String(input.value), paramName: input.paramName as string | undefined };
    }
    case "navigate": {
      const url = String(input.url);
      await surface.perform({ type: "navigate", url });
      return { index, action: "navigate", description: String(input.description), value: url };
    }
    case "extract": {
      const locator = input.locator as ElementLocator;
      const value = await surface.extract(locator);
      return { index, action: "extract", description: String(input.description), locator, outputKey: String(input.outputKey), extractedValue: value };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * The observe -> decide -> act loop. Claude perceives the page via an accessibility-tree
 * snapshot plus a screenshot, and acts by calling one of the tools in DISCOVERY_TOOLS.
 * Every candidate action is checked against the allowlist before it touches the Surface;
 * the loop stops on finish(), on an explicit escalate() call, or on max-steps/timeout
 * (which itself triggers an escalation rather than silently giving up).
 */
export async function runDiscoveryLoop(opts: DiscoveryLoopOptions): Promise<DiscoveryResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  const maxSteps = opts.maxSteps ?? 25;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const startedAt = Date.now();

  const trace: TraceEntry[] = [];
  const outputs: Record<string, string> = {};
  const messages: Anthropic.MessageParam[] = [];

  const { obs: initialObs, shotPath: initialShot } = await captureObservation(opts.surface, opts.logger, "step-0");
  opts.logger.log("system", "observation", { step: 0, url: initialObs.url });

  messages.push({
    role: "user",
    content: [
      { type: "text", text: `GOAL: ${opts.goal}\n\nObservation (step 0):\nURL: ${initialObs.url}\nAccessibility snapshot:\n${initialObs.ariaSnapshot}` },
      imageBlockFromFile(initialShot),
    ],
  });

  let step = 0;
  while (true) {
    if (step >= maxSteps || Date.now() - startedAt > timeoutMs) {
      const reason = step >= maxSteps ? "max_steps_reached" : "timeout";
      opts.logger.log("system", "stopping_condition", { reason, step });
      const { humanActionsSummary } = await opts.escalation.escalate({
        capability: opts.goal,
        stepIndex: step,
        reason: `Discovery did not finish within its budget (${reason}).`,
      });
      opts.logger.log("human", "resume", { humanActionsSummary });
      return { success: false, reason: `${reason}_escalated: ${humanActionsSummary}`, trace, outputs };
    }

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: buildSystemPrompt(opts.goal, opts.allowedDomains),
      tools: DISCOVERY_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    if (textBlocks.length) {
      opts.logger.log("agent", "reasoning", { step, text: textBlocks.map((b) => b.text).join("\n") });
    }

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      messages.push({ role: "user", content: [{ type: "text", text: "Call exactly one tool to proceed toward the goal." }] });
      step++;
      continue;
    }

    const input = toolUse.input as Record<string, unknown>;
    opts.logger.log("agent", "decision", { step, tool: toolUse.name, input: sanitizeToolInputForLog(toolUse.name, input) });

    if (toolUse.name === "finish") {
      const parsedCheckpoint = input.success ? CheckpointSchema.safeParse(input.successCheckpoint) : undefined;
      opts.logger.log("agent", "finish", { success: !!input.success, reason: input.reason });
      return {
        success: !!input.success,
        reason: String(input.reason ?? ""),
        trace,
        outputs,
        successCheckpoint: parsedCheckpoint?.success ? parsedCheckpoint.data : undefined,
      };
    }

    if (toolUse.name === "escalate") {
      const { humanActionsSummary } = await opts.escalation.escalate({
        capability: opts.goal,
        stepIndex: step,
        reason: String(input.reason ?? "Agent requested escalation."),
      });
      opts.logger.log("human", "resume", { humanActionsSummary });

      const { obs, shotPath } = await captureObservation(opts.surface, opts.logger, `step-${step}-post-human`);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: [
              {
                type: "text",
                text: `A human operator intervened and reports: "${humanActionsSummary}". Continue toward the goal from the current state.\nURL: ${obs.url}\nAccessibility snapshot:\n${obs.ariaSnapshot}`,
              },
              imageBlockFromFile(shotPath),
            ],
          },
        ],
      });
      step++;
      continue;
    }

    const candidate = toCandidateAction(toolUse.name, input);
    const decision = opts.policy.evaluate(candidate, opts.surface.currentUrl());
    if (!decision.allowed) {
      opts.logger.log("system", "policy_block", { step, tool: toolUse.name, reason: decision.reason });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `BLOCKED by safety policy: ${decision.reason}. Choose a different, allowed action, or call finish/escalate.`,
            is_error: true,
          },
        ],
      });
      step++;
      continue;
    }

    try {
      const traceEntry = await executeTool(toolUse.name, input, opts.surface, step);
      trace.push(traceEntry);
      if (traceEntry.outputKey && traceEntry.extractedValue !== undefined) {
        outputs[traceEntry.outputKey] = traceEntry.extractedValue;
      }

      const { obs, shotPath } = await captureObservation(opts.surface, opts.logger, `step-${step + 1}`);
      opts.logger.log("system", "action_result", { step, tool: toolUse.name, url: obs.url });

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: [
              { type: "text", text: `Action executed. URL: ${obs.url}\nAccessibility snapshot:\n${obs.ariaSnapshot}` },
              imageBlockFromFile(shotPath),
            ],
          },
        ],
      });
    } catch (err) {
      const message = err instanceof LocatorNotFoundError ? err.message : String(err);
      opts.logger.log("system", "action_error", { step, tool: toolUse.name, error: message });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Action failed: ${message}. Try a different locator/tier, or escalate if you're stuck.`,
            is_error: true,
          },
        ],
      });
    }

    step++;
  }
}
