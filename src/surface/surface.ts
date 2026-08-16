/**
 * The seam between "how we perceive/act on a surface" and "the recorded flow."
 *
 * Both the discovery agent loop and the replay engine talk only to this interface,
 * never to Playwright (or any other automation technology) directly. A future legacy
 * web surface (framesets, table layouts) or a desktop surface (OS accessibility APIs)
 * implements the same interface; nothing above this line needs to change.
 */

// ElementLocator is defined in the artifact schema (src/artifact/schema.ts) since it's
// the shape persisted in capability artifacts; the Surface layer reuses that type so
// discovery, artifacts, and replay all speak the same locator language.
import type { ElementLocator } from "../artifact/schema.js";
export type { ElementLocator };

export interface Observation {
  url: string;
  title: string;
  /** YAML-like accessibility tree snapshot. Primary perception signal — works without a clean DOM. */
  ariaSnapshot: string;
}

export type SurfaceAction =
  | { type: "click"; locator: ElementLocator }
  | { type: "type"; locator: ElementLocator; text: string }
  | { type: "select"; locator: ElementLocator; value: string }
  | { type: "navigate"; url: string }
  | { type: "wait_for"; locator: ElementLocator; timeoutMs?: number };

export type LocatorTier = "role" | "testId" | "text" | "css";

export interface LocatorResolution {
  found: boolean;
  tierUsed?: LocatorTier;
  matchedCount?: number;
}

export interface Surface {
  observe(): Promise<Observation>;
  perform(action: SurfaceAction): Promise<void>;
  /** Reads text content out of the element the locator resolves to. */
  extract(locator: ElementLocator): Promise<string>;
  /** Attempts to resolve a locator without acting on it — used by replay for checkpoints. */
  resolveLocator(locator: ElementLocator, timeoutMs?: number): Promise<LocatorResolution>;
  screenshot(destPath: string): Promise<void>;
  currentUrl(): string;
  close(): Promise<void>;
}

/** Thrown by any Surface implementation when no locator tier resolves. Surface-agnostic
 * so the replay engine and agent loop can catch it without depending on Playwright. */
export class LocatorNotFoundError extends Error {
  constructor(public readonly locator: ElementLocator) {
    super(`Could not resolve locator through any tier: ${JSON.stringify(locator)}`);
    this.name = "LocatorNotFoundError";
  }
}
