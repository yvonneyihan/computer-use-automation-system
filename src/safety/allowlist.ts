import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { ElementLocator } from "../artifact/schema.js";

const RiskyMatcherSchema = z.object({
  reason: z.string(),
  locatorText: z.array(z.string()).default([]),
  locatorTestId: z.array(z.string()).default([]),
});

const AllowlistConfigSchema = z.object({
  allowedDomains: z.array(z.string()),
  allowedActionTypes: z.array(z.string()),
  riskyActionMatchers: z.array(RiskyMatcherSchema).default([]),
});

export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export type ActionType = "click" | "type" | "select" | "navigate" | "wait_for" | "extract";

export interface CandidateAction {
  type: ActionType;
  url?: string; // for navigate
  locatorText?: string; // visible text of the target, if known
  locatorTestId?: string; // data-testid of the target, if known
}

export type PolicyDecision =
  | { allowed: true; risk: "safe" | "risky" }
  | { allowed: false; reason: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../../config/allowlist.json");

export function loadAllowlistConfig(configPath: string = DEFAULT_CONFIG_PATH): AllowlistConfig {
  const raw = readFileSync(configPath, "utf-8");
  return AllowlistConfigSchema.parse(JSON.parse(raw));
}

/** Pulls the fields a risky-action matcher can key on out of a locator. */
export function locatorToCandidateFields(locator?: ElementLocator): { locatorText?: string; locatorTestId?: string } {
  if (!locator) return {};
  return { locatorText: locator.text ?? locator.role?.name, locatorTestId: locator.testId };
}

/**
 * Enforces the allowlist: domain scope, permitted action types, and conservative
 * treatment of risky/irreversible actions. Every action — from the discovery agent
 * or from replay — must pass through here before it touches a Surface.
 */
export class AllowlistPolicy {
  constructor(private readonly config: AllowlistConfig) {}

  private isDomainAllowed(url: string): boolean {
    try {
      const target = new URL(url);
      return this.config.allowedDomains.some((allowed) => {
        const allowedUrl = new URL(allowed);
        return target.hostname === allowedUrl.hostname;
      });
    } catch {
      return false;
    }
  }

  private matchesRiskyMatcher(action: CandidateAction): string | undefined {
    for (const matcher of this.config.riskyActionMatchers) {
      const textHit = action.locatorText
        ? matcher.locatorText.some((t) => action.locatorText!.toLowerCase().includes(t.toLowerCase()))
        : false;
      const testIdHit = action.locatorTestId ? matcher.locatorTestId.includes(action.locatorTestId) : false;
      if (textHit || testIdHit) return matcher.reason;
    }
    return undefined;
  }

  /** Evaluate whether an action may proceed, and classify its risk if so. */
  evaluate(action: CandidateAction, currentUrl: string): PolicyDecision {
    if (!this.config.allowedActionTypes.includes(action.type)) {
      return { allowed: false, reason: `Action type "${action.type}" is not in the allowlist.` };
    }

    const urlToCheck = action.type === "navigate" && action.url ? action.url : currentUrl;
    if (!this.isDomainAllowed(urlToCheck)) {
      return { allowed: false, reason: `Domain of "${urlToCheck}" is not in the allowlist.` };
    }

    const riskyReason = this.matchesRiskyMatcher(action);
    if (riskyReason) {
      // Risky/irreversible actions are blocked by default rather than silently executed.
      // A real deployment would route this to escalation for explicit human confirmation
      // instead of a hard block; we block here since this system has no standing human
      // approver to confirm against.
      return { allowed: false, reason: `Blocked risky action: ${riskyReason}` };
    }

    return { allowed: true, risk: "safe" };
  }
}
