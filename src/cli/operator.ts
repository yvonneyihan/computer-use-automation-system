/**
 * The (mocked) human operator surface. A real deployment would be a co-browsing
 * console; here it's a terminal that reads the intervention context, lets the human
 * interact with the still-open live browser window directly, and then signals resume
 * back to the paused automation process via a shared file in the run's evidence dir.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const { values } = parseArgs({ options: { run: { type: "string" } } });

if (!values.run) {
  console.error("Usage: npm run operator -- --run <runId>");
  process.exit(1);
}

const runDir = path.resolve(process.cwd(), "evidence", values.run);
const interventionPath = path.join(runDir, "intervention.json");

if (!existsSync(interventionPath)) {
  console.error(`No intervention.json found in ${runDir}. Nothing pending for this run.`);
  process.exit(1);
}

const intervention = JSON.parse(readFileSync(interventionPath, "utf-8"));
console.log("=== Intervention context ===");
console.log(JSON.stringify(intervention, null, 2));
console.log("\nA live browser window should be open for this run — interact with it directly.");

const rl = readline.createInterface({ input: stdin, output: stdout });
const summary = await rl.question("\nDescribe what you did, then press enter to hand control back to the agent: ");
rl.close();

intervention.status = "resolved";
intervention.resolvedAt = new Date().toISOString();
intervention.humanActionsSummary = summary || "(no summary provided)";
writeFileSync(interventionPath, JSON.stringify(intervention, null, 2), "utf-8");
writeFileSync(path.join(runDir, "resume.signal"), intervention.humanActionsSummary, "utf-8");

console.log("Resume signal sent — the automation process should continue shortly.");
