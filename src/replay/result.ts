/**
 * The result contract replay reports to its caller. Three distinct kinds, on purpose:
 * a business outcome (e.g. "validation error") is not a failure — it's exactly what the
 * caller needs to know. A hard failure is reserved for conditions the artifact's author
 * didn't anticipate and that a human needs to look at.
 */
export type ReplayOutcome =
  | { kind: "success"; outputs: Record<string, string>; evidenceRef: string }
  | { kind: "business_outcome"; outcome: string; description: string; evidenceRef: string }
  | { kind: "failure"; stepIndex: number; expected: string; observed: string; message: string; evidenceRef: string };
