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
});
