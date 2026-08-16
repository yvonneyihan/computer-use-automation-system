import type Anthropic from "@anthropic-ai/sdk";

type Tool = Anthropic.Tool;

// The agent is deliberately not offered a "css" field — only role/testId/text, the
// three semantic tiers a legacy surface without a clean DOM can still provide. This
// keeps the agent from ever inventing a brittle selector it can't see the raw HTML for
// anyway (perception is the accessibility tree, not markup).
const locatorSchema = {
  type: "object" as const,
  description:
    "Ranked element descriptor. Prefer 'role' (ARIA role + accessible name) whenever the accessibility snapshot shows one. Fall back to 'testId' if a data-testid is visible, then 'text'.",
  properties: {
    role: {
      type: "object",
      properties: { role: { type: "string" }, name: { type: "string" } },
      required: ["role", "name"],
    },
    testId: { type: "string" },
    text: { type: "string" },
    nth: { type: "number", description: "0-indexed disambiguator when multiple elements would otherwise match." },
  },
};

const checkpointSchema = {
  type: "object" as const,
  description: "The on-screen condition that proves a state was reached.",
  properties: {
    type: { type: "string", enum: ["urlMatches", "elementVisible", "elementText"] },
    pattern: { type: "string", description: "For urlMatches: substring/regex of the URL. For elementText: substring of the expected text." },
    locator: locatorSchema,
  },
  required: ["type"],
};

export const DISCOVERY_TOOLS: Tool[] = [
  {
    name: "click",
    description: "Click an element identified by the given locator.",
    input_schema: {
      type: "object",
      properties: { locator: locatorSchema, description: { type: "string", description: "Why this action — used for the audit trail and the recorded capability." } },
      required: ["locator", "description"],
    },
  },
  {
    name: "type",
    description: "Type text into an input identified by the given locator, replacing any existing value.",
    input_schema: {
      type: "object",
      properties: {
        locator: locatorSchema,
        text: { type: "string" },
        paramName: {
          type: "string",
          description:
            "Set this if the value should become a reusable input parameter of the recorded capability (e.g. 'itemName', 'firstName'). Omit for fixed/literal text that should never change on replay.",
        },
        sensitive: { type: "boolean", description: "True if this is a secret/credential. Its literal value will never be persisted — only the parameter name." },
        description: { type: "string" },
      },
      required: ["locator", "text", "description"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> element identified by the given locator.",
    input_schema: {
      type: "object",
      properties: { locator: locatorSchema, value: { type: "string" }, paramName: { type: "string" }, description: { type: "string" } },
      required: ["locator", "value", "description"],
    },
  },
  {
    name: "navigate",
    description: "Navigate directly to a URL, within the allowed domain(s) only.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, description: { type: "string" } },
      required: ["url", "description"],
    },
  },
  {
    name: "extract",
    description: "Read the visible text of an element and record it as a named output of the capability.",
    input_schema: {
      type: "object",
      properties: { locator: locatorSchema, outputKey: { type: "string" }, description: { type: "string" } },
      required: ["locator", "outputKey", "description"],
    },
  },
  {
    name: "finish",
    description: "Declare the goal complete (or definitively not achievable) and stop the loop. Never call this to confirm/submit an irreversible action — stop one screen before that and finish there.",
    input_schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        reason: { type: "string" },
        successCheckpoint: {
          ...checkpointSchema,
          description: "Required if success=true: the condition that proves the goal state was reached. This becomes the artifact's replay checkpoint.",
        },
      },
      required: ["success", "reason"],
    },
  },
  {
    name: "escalate",
    description: "Stop and request a human operator take over the live session, because you cannot safely or confidently proceed (unexpected state, repeated failures, or a step that risks an irreversible action).",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];
