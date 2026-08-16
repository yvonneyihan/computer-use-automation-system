import { describe, expect, it } from "vitest";
import { isSensitiveFieldName, redactObject, redactValue } from "./redact.js";

describe("redact", () => {
  it("redacts a value from a field whose name looks sensitive, regardless of content", () => {
    expect(redactValue("hunter2", "password")).toBe("***REDACTED***");
  });

  it("redacts SSN-like content even in a field with an innocuous name", () => {
    expect(redactValue("SSN on file: 123-45-6789", "notes")).toContain("***REDACTED***");
  });

  it("leaves ordinary values untouched", () => {
    expect(redactValue("Sauce Labs Backpack", "itemName")).toBe("Sauce Labs Backpack");
  });

  it("recursively redacts nested objects by field name", () => {
    const out = redactObject({ user: { password: "hunter2", note: "fine" } }) as any;
    expect(out.user.password).toBe("***REDACTED***");
    expect(out.user.note).toBe("fine");
  });

  it("identifies sensitive field names", () => {
    expect(isSensitiveFieldName("apiToken")).toBe(true);
    expect(isSensitiveFieldName("itemName")).toBe(false);
  });

  it("does not false-positive on ordinary field names that happen to contain 'pin' as a substring", () => {
    // regression: "stepIndex" contains "pIn" (...ste-pIn-dex), which matched the old
    // unbounded /pin/i pattern and redacted plain numeric step indices in result.json
    expect(isSensitiveFieldName("stepIndex")).toBe(false);
    expect(isSensitiveFieldName("evidenceRef")).toBe(false);
  });

  it("still catches a field genuinely named pin", () => {
    expect(isSensitiveFieldName("pin")).toBe(true);
  });

  it("does not mangle a 13-digit epoch timestamp embedded in a file path", () => {
    // regression: run ids embed Date.now() (13 digits), which collided with the
    // credit-card-like digit-run pattern and corrupted evidenceRef paths
    const path = "/evidence/replay-add_item_to_cart_checkout-1786922318692/result.json";
    expect(redactValue(path)).toBe(path);
  });

  it("still redacts a 16-digit card-like number", () => {
    expect(redactValue("card on file: 4111111111111111")).toContain("***REDACTED***");
  });
});
