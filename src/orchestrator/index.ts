import { claudeAgentOrchestrator } from "./claude-agent.js";
import type { Orchestrator } from "./types.js";

export type {
  AskUserHandler,
  Orchestrator,
  OrchestratorOptions,
  OrchestratorRun,
  PermissionMode,
  Snapshot,
  SnapshotState,
} from "./types.js";
export { MissingAnthropicKeyError } from "./types.js";

/**
 * Pick an orchestrator implementation. Today there is only one — the
 * claude-agent backend behind ADR-007. The signature accepts a name so we
 * can add a `local-ollama-tools` (or similar) orchestrator later without
 * changing every call site.
 */
export function getOrchestrator(name: "claude-agent" = "claude-agent"): Orchestrator {
  if (name !== "claude-agent") {
    throw new Error(`unknown orchestrator: ${name}`);
  }
  return claudeAgentOrchestrator;
}
