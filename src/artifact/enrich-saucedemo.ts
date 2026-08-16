import type { CapabilityArtifact } from "./schema.js";

/**
 * Known runtime business outcomes for saucedemo's checkout flow, added here by a human
 * reviewer rather than discovered by the agent. A single discovery run only walks the
 * happy path once — the agent is explicitly instructed not to force failures just to
 * learn error states — so declaring known error/outcome checkpoints is reviewer work
 * that happens once per vendor app and is then reusable across every tenant running
 * that same app (see REPORT.md, Heterogeneity & multi-tenant).
 */
export function enrichSaucedemoOutcomes(artifact: CapabilityArtifact): CapabilityArtifact {
  const hasCheck = artifact.outcomeChecks.some((c) => c.name === "validation_error");
  if (hasCheck) return artifact;

  return {
    ...artifact,
    updatedAt: new Date().toISOString(),
    outcomeChecks: [
      ...artifact.outcomeChecks,
      {
        name: "validation_error",
        description: "A required checkout field (first name, last name, or zip/postal code) was left blank.",
        mapsTo: "business_outcome",
        checkpoint: {
          type: "elementText",
          locator: { testId: "error" },
          pattern: "required",
        },
      },
    ],
  };
}
