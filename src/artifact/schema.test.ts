import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateArtifact } from "./schema.js";

function validArtifact() {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id: randomUUID(),
    name: "test_capability",
    description: "test",
    version: 1,
    status: "draft",
    target: { app: "test-app", baseUrl: "https://example.test" },
    createdAt: now,
    updatedAt: now,
    createdBy: "human",
    inputSchema: {},
    outputSchema: {},
    steps: [{ index: 0, action: "click", description: "go", locator: { text: "Go" } }],
    successCheckpoint: { type: "urlMatches", pattern: "done" },
    outcomeChecks: [],
    recoverySpec: [],
    policy: { allowedDomains: ["https://example.test"], riskLevel: "safe" },
  };
}

describe("CapabilityArtifactSchema", () => {
  it("accepts a well-formed artifact", () => {
    expect(() => validateArtifact(validArtifact())).not.toThrow();
  });

  it("rejects a target with an invalid baseUrl", () => {
    const bad = { ...validArtifact(), target: { app: "x", baseUrl: "not-a-url" } };
    expect(() => validateArtifact(bad)).toThrow();
  });

  it("rejects a checkpoint of an unrecognized type", () => {
    const bad = { ...validArtifact(), successCheckpoint: { type: "somethingElse" } };
    expect(() => validateArtifact(bad)).toThrow();
  });

  it("rejects a non-uuid id", () => {
    const bad = { ...validArtifact(), id: "not-a-uuid" };
    expect(() => validateArtifact(bad)).toThrow();
  });

  it("rejects an unknown action type on a step", () => {
    const bad = { ...validArtifact(), steps: [{ index: 0, action: "drag", description: "x" }] };
    expect(() => validateArtifact(bad)).toThrow();
  });
});
