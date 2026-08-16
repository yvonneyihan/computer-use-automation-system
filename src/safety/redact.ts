/**
 * Redaction utilities. Applied before anything is written to logs, artifacts, or
 * evidence files — regulated financial data must never be persisted in the clear.
 */

const REDACTED = "***REDACTED***";

// Field names/roles that are always sensitive regardless of content. "pin" is
// word-bounded (unlike the others) because as a bare 3-letter substring it produces
// false positives on ordinary camelCase names — e.g. "stepIndex" contains "pIn".
const SENSITIVE_FIELD_NAME_PATTERN = /pass(word)?|secret|token|ssn|social.?security|credit.?card|cvv|\bpin\b/i;

// Content patterns redacted as defense in depth, even in fields not flagged sensitive.
const CONTENT_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b(?:\d[ -]*?){13,19}\b/g, // credit-card-like digit runs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
];

export function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_NAME_PATTERN.test(fieldName);
}

/** Redact a single value, given the semantic field name it came from (if known). */
export function redactValue(value: string, fieldName?: string): string {
  if (fieldName && isSensitiveFieldName(fieldName)) return REDACTED;
  let out = value;
  for (const pattern of CONTENT_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Recursively redact sensitive values out of a plain JSON-like object, for logging. */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactValue(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((v) => redactObject(v)) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) {
        out[key] = REDACTED;
      } else if (typeof val === "string") {
        out[key] = redactValue(val, key);
      } else {
        out[key] = redactObject(val);
      }
    }
    return out as T;
  }
  return obj;
}

/** Redact a free-text log line (defense in depth over structured redaction). */
export function redactText(text: string): string {
  return redactValue(text);
}
