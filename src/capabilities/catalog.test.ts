import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listCapabilities, toAnthropicTools } from "./catalog.js";
import { ArtifactStore } from "../artifact/store.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

function sampleArtifact(): CapabilityArtifact {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id: randomUUID(),
    name: "test_capability",
    description: "Adds an item to the cart and reaches checkout overview.",
    version: 1,
    status: "approved",
    target: { app: "test-app", baseUrl: "https://example.test", testIdAttribute: "data-testid" },
    createdAt: now,
    updatedAt: now,
    createdBy: "discovery-agent",
    inputSchema: {
      itemName: { type: "string", description: "Item to add", required: true, sensitive: false },
      password: { type: "string", description: "Login password", required: true, sensitive: true },
      quantity: { type: "number", description: "How many", required: false, sensitive: false },
    },
    outputSchema: {
      total: { type: "string", description: "Order total", required: true, sensitive: false },
    },
    steps: [{ index: 0, action: "click", description: "go", locator: { text: "Go" } }],
    successCheckpoint: { type: "urlMatches", pattern: "done" },
    outcomeChecks: [],
    recoverySpec: [],
    policy: { allowedDomains: ["https://example.test"], riskLevel: "safe" },
  };
}

describe("listCapabilities", () => {
  it("reads a saved artifact back as a capability summary", () => {
    const dir = path.join(os.tmpdir(), `cua-catalog-test-${randomUUID()}`);
    const store = new ArtifactStore(dir);
    store.save(sampleArtifact());

    const capabilities = listCapabilities(store);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].name).toBe("test_capability");
    expect(capabilities[0].inputSchema.itemName.type).toBe("string");
  });
});

describe("toAnthropicTools", () => {
  it("converts a capability into a well-formed tool definition", () => {
    const dir = path.join(os.tmpdir(), `cua-catalog-test-${randomUUID()}`);
    const store = new ArtifactStore(dir);
    store.save(sampleArtifact());

    const [tool] = toAnthropicTools(listCapabilities(store));
    expect(tool.name).toBe("test_capability");
    expect(tool.input_schema.type).toBe("object");
    const properties = tool.input_schema.properties as Record<string, { type: string; description: string }>;
    expect(properties.itemName.type).toBe("string");
    expect(properties.quantity.type).toBe("number");
  });

  it("marks only genuinely required fields as required, and flags sensitive ones in the description", () => {
    const dir = path.join(os.tmpdir(), `cua-catalog-test-${randomUUID()}`);
    const store = new ArtifactStore(dir);
    store.save(sampleArtifact());

    const [tool] = toAnthropicTools(listCapabilities(store));
    expect(tool.input_schema.required).toEqual(expect.arrayContaining(["itemName", "password"]));
    expect(tool.input_schema.required).not.toContain("quantity");

    const properties = tool.input_schema.properties as Record<string, { description: string }>;
    expect(properties.password.description).toContain("sensitive");
    expect(properties.itemName.description).not.toContain("sensitive");
  });
});