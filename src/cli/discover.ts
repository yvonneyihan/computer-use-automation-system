import "dotenv/config";
import { parseArgs } from "node:util";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { AllowlistPolicy, loadAllowlistConfig } from "../safety/allowlist.js";
import { RunLogger } from "../observability/logger.js";
import { EscalationController } from "../escalation/manager.js";
import { runDiscoveryLoop } from "../agent/loop.js";
import { recordArtifact } from "../artifact/recorder.js";
import { enrichSaucedemoOutcomes } from "../artifact/enrich-saucedemo.js";
import { ArtifactStore } from "../artifact/store.js";

const { values } = parseArgs({
  options: {
    goal: { type: "string" },
    target: { type: "string", default: "https://www.saucedemo.com" },
    name: { type: "string", default: "add_item_to_cart_checkout" },
    "max-steps": { type: "string" },
    "test-id-attr": { type: "string", default: "data-test" },
  },
});

if (!values.goal) {
  console.error('Usage: npm run discover -- --goal "<goal>" [--target <url>] [--name <capability_name>]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const goal = values.goal;
const baseUrl = values.target!;
const name = values.name!;

const config = loadAllowlistConfig();
const policy = new AllowlistPolicy(config);
const logger = new RunLogger("discovery", name);
const escalation = new EscalationController(logger.dir);
const headed = process.env.HEADED !== "false";

console.log(`Discovery run starting against ${baseUrl}`);
console.log(`Goal: ${goal}`);
console.log(`Evidence: ${logger.dir}`);

const testIdAttribute = values["test-id-attr"]!;
const surface = await PlaywrightSurface.launch(baseUrl, { headed, testIdAttribute });

try {
  const result = await runDiscoveryLoop({
    goal,
    surface,
    policy,
    allowedDomains: config.allowedDomains,
    logger,
    escalation,
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
  });
  logger.writeResult(result);

  if (!result.success) {
    console.error(`\nDiscovery did not succeed: ${result.reason}`);
    process.exitCode = 1;
  } else {
    const finalUrl = surface.currentUrl();
    let artifact = recordArtifact({
      name,
      description: goal,
      appName: "saucedemo",
      baseUrl,
      testIdAttribute,
      allowedDomains: config.allowedDomains,
      result,
      finalUrl,
    });
    artifact = enrichSaucedemoOutcomes(artifact);

    const store = new ArtifactStore();
    const dest = store.save(artifact);
    console.log(`\nGoal completed. Saved capability artifact: ${dest}`);
    console.log(`Evidence: ${logger.dir}`);
    console.log(`\nReplay it with:\n  npm run replay -- --artifact ${dest} --params '${JSON.stringify(buildSampleParams(artifact))}'`);
  }
} finally {
  await surface.close();
  logger.close();
}

function buildSampleParams(artifact: { inputSchema: Record<string, { sensitive?: boolean }> }): Record<string, string> {
  const sample: Record<string, string> = {};
  for (const key of Object.keys(artifact.inputSchema)) {
    sample[key] = artifact.inputSchema[key].sensitive ? "<secret>" : "<value>";
  }
  return sample;
}
