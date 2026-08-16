import { z } from "zod";

/**
 * A ranked element descriptor, not a single selector. Replay resolves tiers in
 * priority order (role -> testId -> text -> css) so a capability keeps working even
 * against markup that lacks stable identifiers — the norm in legacy enterprise UIs.
 * This is also the canonical locator shape used by the Surface layer (src/surface).
 */
export const ElementLocatorSchema = z.object({
  role: z.object({ role: z.string(), name: z.string() }).optional(),
  testId: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  nth: z.number().int().nonnegative().optional(),
});
export type ElementLocator = z.infer<typeof ElementLocatorSchema>;

export const CheckpointSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("urlMatches"), pattern: z.string() }),
  z.object({ type: z.literal("elementVisible"), locator: ElementLocatorSchema }),
  z.object({ type: z.literal("elementText"), locator: ElementLocatorSchema, pattern: z.string() }),
  z.object({ type: z.literal("elementCount"), locator: ElementLocatorSchema, expectedCount: z.number().int() }),
]);
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const StepActionTypeSchema = z.enum(["click", "type", "select", "navigate", "wait_for", "extract"]);
export type StepActionType = z.infer<typeof StepActionTypeSchema>;

export const StepSchema = z.object({
  index: z.number().int().nonnegative(),
  action: StepActionTypeSchema,
  /** Human-readable rationale for reviewers — what this step does and why this locator was chosen. */
  description: z.string(),
  locator: ElementLocatorSchema.optional(),
  /** For "type"/"select"/"navigate" actions. Supports {{paramName}} interpolation from inputs. */
  valueTemplate: z.string().optional(),
  /** For "extract" actions — the key this value is written to in the output payload. */
  outputKey: z.string().optional(),
  /** Optional per-step assertion, checked immediately after the action executes. */
  checkpoint: CheckpointSchema.optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** A condition that, if matched during replay, is a legitimate business result — not a crash. */
export const OutcomeCheckSchema = z.object({
  name: z.string(),
  checkpoint: CheckpointSchema,
  mapsTo: z.literal("business_outcome"),
  description: z.string(),
});
export type OutcomeCheck = z.infer<typeof OutcomeCheckSchema>;

/** Cross-cutting interstitials (cookie banners, unexpected dialogs) watched for at every step. */
export const RecoverySpecEntrySchema = z.object({
  name: z.string(),
  trigger: ElementLocatorSchema,
  action: z.enum(["dismiss"]),
});
export type RecoverySpecEntry = z.infer<typeof RecoverySpecEntrySchema>;

export const ParamFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  /** Marks the field as sensitive so replay/logging redact its value everywhere. */
  sensitive: z.boolean().default(false),
});
export type ParamField = z.infer<typeof ParamFieldSchema>;

export const PolicySchema = z.object({
  allowedDomains: z.array(z.string()),
  riskLevel: z.enum(["safe", "risky"]),
});

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "approved"]),
  target: z.object({
    app: z.string(),
    baseUrl: z.string().url(),
    /** The DOM attribute the "testId" locator tier reads for this app (vendor apps vary: data-testid, data-test, data-qa, ...). */
    testIdAttribute: z.string().default("data-testid"),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.enum(["discovery-agent", "human"]),

  inputSchema: z.record(z.string(), ParamFieldSchema),
  outputSchema: z.record(z.string(), ParamFieldSchema),

  steps: z.array(StepSchema),
  successCheckpoint: CheckpointSchema,
  outcomeChecks: z.array(OutcomeCheckSchema).default([]),
  recoverySpec: z.array(RecoverySpecEntrySchema).default([]),

  policy: PolicySchema,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export function validateArtifact(data: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(data);
}
