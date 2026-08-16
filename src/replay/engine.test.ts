import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replayArtifact } from "./engine.js";
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { Surface, SurfaceAction } from "../surface/surface.js";
import { AllowlistPolicy } from "../safety/allowlist.js";
import { RunLogger } from "../observability/logger.js";
import type { EscalationController } from "../escalation/manager.js";

function baseArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id: randomUUID(),
    name: "test_capability",
    description: "test",
    version: 1,
    status: "draft",
    target: { app: "test-app", baseUrl: "https://example.test", testIdAttribute: "data-testid" },
    createdAt: now,
    updatedAt: now,
    createdBy: "human",
    inputSchema: {},
    outputSchema: {},
    steps: [{ index: 0, action: "click", description: "click go", locator: { text: "Go" } }],
    successCheckpoint: { type: "urlMatches", pattern: "done" },
    outcomeChecks: [],
    recoverySpec: [],
    policy: { allowedDomains: ["https://example.test"], riskLevel: "safe" },
    ...overrides,
  };
}

/** A minimal in-memory Surface double — no browser involved. */
function makeMockSurface(opts: { clickThrows?: boolean; urlAfterClick?: string; textAfterClick?: string }): Surface {
  let url = "https://example.test/start";
  return {
    async observe() {
      return { url, title: "", ariaSnapshot: opts.textAfterClick ?? "" };
    },
    async perform(action: SurfaceAction) {
      if (action.type === "click") {
        if (opts.clickThrows) throw new Error("simulated click failure");
        url = opts.urlAfterClick ?? url;
      }
    },
    async extract() {
      return opts.textAfterClick ?? "";
    },
    async resolveLocator() {
      return { found: true, tierUsed: "text", matchedCount: 1 };
    },
    async screenshot() {},
    currentUrl() {
      return url;
    },
    async close() {},
  };
}

const policy = new AllowlistPolicy({
  allowedDomains: ["https://example.test"],
  allowedActionTypes: ["click", "type", "select", "navigate", "wait_for", "extract"],
  riskyActionMatchers: [],
});

function testLogger(): RunLogger {
  return new RunLogger("replay", `test-${randomUUID()}`, path.join(os.tmpdir(), "cua-system-tests"));
}

function fakeEscalation(onEscalate?: () => void): EscalationController {
  return {
    controller: "agent",
    escalate: async () => {
      onEscalate?.();
      return { humanActionsSummary: "test operator: no-op" };
    },
  } as unknown as EscalationController;
}

describe("replayArtifact", () => {
  it("returns success when every step and the final checkpoint pass", async () => {
    const artifact = baseArtifact();
    const surface = makeMockSurface({ urlAfterClick: "https://example.test/done" });
    const outcome = await replayArtifact({ artifact, params: {}, surface, policy, logger: testLogger(), escalation: fakeEscalation() });
    expect(outcome.kind).toBe("success");
  });

  it("classifies a matched outcomeCheck as a business_outcome, not a failure", async () => {
    const artifact = baseArtifact({
      outcomeChecks: [
        {
          name: "validation_error",
          description: "A required field was left blank.",
          mapsTo: "business_outcome",
          checkpoint: { type: "elementText", locator: { testId: "error" }, pattern: "required" },
        },
      ],
    });
    const surface = makeMockSurface({ clickThrows: true, textAfterClick: "Error: First Name is required" });
    const outcome = await replayArtifact({ artifact, params: {}, surface, policy, logger: testLogger(), escalation: fakeEscalation() });
    expect(outcome.kind).toBe("business_outcome");
    if (outcome.kind === "business_outcome") expect(outcome.outcome).toBe("validation_error");
  });

  it("classifies an unrecognized failure as a hard failure, and escalates to a human", async () => {
    const artifact = baseArtifact();
    const surface = makeMockSurface({ clickThrows: true, textAfterClick: "Something unrelated" });
    let escalated = false;
    const outcome = await replayArtifact({
      artifact,
      params: {},
      surface,
      policy,
      logger: testLogger(),
      escalation: fakeEscalation(() => (escalated = true)),
    });
    expect(outcome.kind).toBe("failure");
    expect(escalated).toBe(true);
  });

  it("rejects a replay that's missing a required input parameter", async () => {
    const artifact = baseArtifact({
      inputSchema: { itemName: { type: "string", description: "item", required: true, sensitive: false } },
    });
    const surface = makeMockSurface({ urlAfterClick: "https://example.test/done" });
    await expect(
      replayArtifact({ artifact, params: {}, surface, policy, logger: testLogger(), escalation: fakeEscalation() }),
    ).rejects.toThrow(/Missing required input parameter/);
  });
});
