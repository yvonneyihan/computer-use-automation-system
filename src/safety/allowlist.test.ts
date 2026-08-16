import { describe, expect, it } from "vitest";
import { AllowlistPolicy } from "./allowlist.js";

const policy = new AllowlistPolicy({
  allowedDomains: ["https://www.saucedemo.com"],
  allowedActionTypes: ["click", "type", "navigate", "extract"],
  riskyActionMatchers: [{ reason: "Finalizes an order", locatorText: ["Finish"], locatorTestId: ["finish"] }],
});

describe("AllowlistPolicy", () => {
  it("allows an action within domain and action-type scope", () => {
    const decision = policy.evaluate({ type: "click", locatorText: "Add to cart" }, "https://www.saucedemo.com/inventory.html");
    expect(decision.allowed).toBe(true);
  });

  it("blocks navigation outside the allowed domain", () => {
    const decision = policy.evaluate({ type: "navigate", url: "https://evil.example.com" }, "https://www.saucedemo.com/inventory.html");
    expect(decision.allowed).toBe(false);
  });

  it("blocks an action type not in the allowlist", () => {
    const decision = policy.evaluate({ type: "select", locatorText: "x" }, "https://www.saucedemo.com/inventory.html");
    expect(decision.allowed).toBe(false);
  });

  it("blocks a risky/irreversible action matched by visible text, even within an allowed domain", () => {
    const decision = policy.evaluate({ type: "click", locatorText: "Finish" }, "https://www.saucedemo.com/checkout-step-two.html");
    expect(decision.allowed).toBe(false);
  });

  it("blocks a risky action matched by testId", () => {
    const decision = policy.evaluate({ type: "click", locatorTestId: "finish" }, "https://www.saucedemo.com/checkout-step-two.html");
    expect(decision.allowed).toBe(false);
  });
});
