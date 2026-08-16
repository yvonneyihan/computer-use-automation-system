import "dotenv/config";
import { parseArgs } from "node:util";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../safety/allowlist.js";
import { RunLogger } from "../observability/logger.js";
import { EscalationController } from "../escalation/manager.js";
import { replayArtifact } from "../replay/engine.js";
import { ArtifactStore } from "../artifact/store.js";

const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    params: { type: "string", default: "{}" },
  },
});

if (!values.artifact) {
  console.error('Usage: npm run replay -- --artifact <path-or-name> --params \'{"key":"value"}\'');
  process.exit(1);
}

const store = new ArtifactStore();
const artifact = store.load(values.artifact);
const params = JSON.parse(values.params!);

const config = loadAllowlistConfig();
const policy = new AllowlistPolicy(config);
const logger = new RunLogger("replay", artifact.name);
const escalation = new EscalationController(logger.dir);
const headed = process.env.HEADED !== "false";

console.log(`Replay run starting: capability "${artifact.name}" v${artifact.version}`);
console.log(`Evidence: ${logger.dir}`);

const surface = await PlaywrightSurface.launch(artifact.target.baseUrl, {
  headed,
  testIdAttribute: artifact.target.testIdAttribute,
});

try {
  const outcome = await replayArtifact({ artifact, params, surface, policy, logger, escalation });
  logger.writeResult(outcome);
  console.log(`\nResult: ${outcome.kind}`);
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode = outcome.kind === "failure" ? 1 : 0;
} finally {
  await surface.close();
  logger.close();
}
