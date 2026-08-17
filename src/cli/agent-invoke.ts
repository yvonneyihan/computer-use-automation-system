/**
 * A minimal stand-in for the "agent-facing product" the whole system exists to serve
 * (see REPORT.md / the assignment's own framing): an LLM is shown the capability catalog
 * as tools, picks one by name and fills in typed args from a natural-language
 * instruction, and that choice is dispatched to the deterministic replay engine — no LLM
 * involved in actually executing it. One real Claude call, not a loop, so it's cheap.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { listCapabilities, toAnthropicTools } from "../capabilities/catalog.js";
import { invokeCapability } from "../capabilities/invoke.js";

const { values } = parseArgs({ options: { instruction: { type: "string" } } });

if (!values.instruction) {
  console.error('Usage: npm run agent-invoke -- --instruction "..."');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const capabilities = listCapabilities();
if (capabilities.length === 0) {
  console.error("No capabilities saved yet. Run `npm run discover` first.");
  process.exit(1);
}

const tools = toAnthropicTools(capabilities);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

console.log(`Calling agent sees ${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"}: ${capabilities.map((c) => c.name).join(", ")}`);
console.log(`Instruction: ${values.instruction}\n`);

const response = await anthropic.messages.create({
  model,
  max_tokens: 512,
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  tools,
  messages: [{ role: "user", content: values.instruction }],
});

const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
if (textBlocks.length) console.log(`Agent: ${textBlocks.map((b) => b.text).join(" ")}\n`);

const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
if (!toolUse) {
  console.log("The calling agent didn't choose a capability to invoke — nothing to run.");
  process.exit(0);
}

console.log(`Agent chose capability "${toolUse.name}" with args:`, toolUse.input);
console.log("Invoking it via the deterministic replay engine (no LLM in this part)...\n");

const outcome = await invokeCapability(toolUse.name, toolUse.input as Record<string, string>);
console.log(`Result: ${outcome.kind}`);
console.log(JSON.stringify(outcome, null, 2));
process.exitCode = outcome.kind === "failure" ? 1 : 0;