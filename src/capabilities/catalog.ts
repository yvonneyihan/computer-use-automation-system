import type Anthropic from "@anthropic-ai/sdk";
import { ArtifactStore } from "../artifact/store.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

export interface CapabilitySummary {
  name: string;
  description: string;
  version: number;
  status: "draft" | "approved";
  inputSchema: CapabilityArtifact["inputSchema"];
  outputSchema: CapabilityArtifact["outputSchema"];
}

/** Reads every saved artifact and summarizes it as a discoverable capability. */
export function listCapabilities(store: ArtifactStore = new ArtifactStore()): CapabilitySummary[] {
  return store.list().map((file) => {
    const artifact = store.load(file);
    return {
      name: artifact.name,
      description: artifact.description,
      version: artifact.version,
      status: artifact.status,
      inputSchema: artifact.inputSchema,
      outputSchema: artifact.outputSchema,
    };
  });
}

/**
 * Converts saved capabilities into Anthropic tool definitions, so an LLM-driven caller
 * can discover and invoke them exactly like any other tool — by name, with typed args.
 * Sensitive input fields stay flagged in their description; the literal *value* a caller
 * supplies is never persisted (invoke.ts dispatches straight to the replay engine, which
 * already redacts sensitive params — see src/safety/redact.ts).
 */
export function toAnthropicTools(capabilities: CapabilitySummary[]): Anthropic.Tool[] {
  return capabilities.map((cap) => ({
    name: cap.name,
    description: `${cap.description} (capability v${cap.version}, status: ${cap.status}). Returns: ${
      Object.keys(cap.outputSchema).join(", ") || "no extracted outputs"
    }.`,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(cap.inputSchema).map(([key, field]) => [
          key,
          { type: field.type, description: field.sensitive ? `${field.description} (sensitive)` : field.description },
        ]),
      ),
      required: Object.entries(cap.inputSchema)
        .filter(([, field]) => field.required)
        .map(([key]) => key),
    },
  }));
}