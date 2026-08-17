import { ArtifactStore } from "../artifact/store.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../safety/allowlist.js";
import { RunLogger } from "../observability/logger.js";
import { EscalationController } from "../escalation/manager.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { replayArtifact } from "../replay/engine.js";
import type { ReplayOutcome } from "../replay/result.js";

export interface InvokeOptions {
  headed?: boolean;
}

/**
 * Dispatches an agent-facing invocation to the exact same deterministic replay path the
 * `replay` CLI uses. This interface is a discovery/dispatch layer, not a second
 * execution engine — it inherits every allowlist, redaction, and result-contract
 * guarantee replay already has, rather than re-implementing (and risking diverging from)
 * any of them.
 */
export async function invokeCapability(
  name: string,
  args: Record<string, string>,
  opts: InvokeOptions = {},
): Promise<ReplayOutcome> {
  const store = new ArtifactStore();
  const artifact = store.load(name);

  const config = loadAllowlistConfig();
  const policy = new AllowlistPolicy(config);
  const logger = new RunLogger("replay", `capability-${artifact.name}`);
  const escalation = new EscalationController(logger.dir);
  const headed = opts.headed ?? process.env.HEADED !== "false";

  const surface = await PlaywrightSurface.launch(artifact.target.baseUrl, {
    headed,
    testIdAttribute: artifact.target.testIdAttribute,
  });

  try {
    const outcome = await replayArtifact({ artifact, params: args, surface, policy, logger, escalation });
    logger.writeResult(outcome);
    return outcome;
  } finally {
    await surface.close();
    logger.close();
  }
}