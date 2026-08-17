import { listCapabilities } from "../capabilities/catalog.js";

const capabilities = listCapabilities();

if (capabilities.length === 0) {
  console.log("No capabilities saved yet. Run `npm run discover` first.");
  process.exit(0);
}

for (const cap of capabilities) {
  console.log(`\n${cap.name} (v${cap.version}, ${cap.status})`);
  console.log(`  ${cap.description}`);
  const inputs = Object.entries(cap.inputSchema)
    .map(([key, field]) => `${key}${field.required ? "" : "?"}: ${field.type}${field.sensitive ? " [sensitive]" : ""}`)
    .join(", ");
  console.log(`  inputs:  ${inputs || "(none)"}`);
  console.log(`  outputs: ${Object.keys(cap.outputSchema).join(", ") || "(none)"}`);
}