/**
 * Public types for the Orchestrator layer (CTX-002 §System spec).
 *
 * This file intentionally does NOT import xstate or
 * @anthropic-ai/claude-agent-sdk — it is the boundary that command code
 * (src/commands/consult.ts, src/commands/plan.ts, future chi gate/approve)
 * subscribes to. See ADR-008 §Decision rule 1.
 */

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

export interface OrchestratorOptions {
  /** Resolved by src/workspace.ts:resolveWorkspaceRoot(). */
  cwd: string;
  /** Default "plan" (read-only). CTX-002 §R3 / Defaults table. */
  permissionMode: PermissionMode;
  /** SDK built-in tool names + chi.* tool names. */
  allowedTools: string[];
  /** Default "claude-opus-4-7". */
  model?: string;
  /** Pluggable terminal Q&A; default = readline (see ask-user.ts). */
  askUser?: AskUserHandler;
  /** Optional system-prompt suffix for persona injection. */
  systemPrompt?: string;
}

export interface AskUserHandler {
  prompt(question: string, options?: string[]): Promise<string>;
}

/**
 * Stable, narrow view chi commands subscribe to. Hides xstate internals so
 * the state-machine library can be swapped (ADR-008 Alternative A) without
 * touching command code.
 *
 * The dotted state names mirror the XState machine paths in state-machine.ts.
 */
export type SnapshotState =
  | "idle"
  | "running.receivingText"
  | "running.executingTool.builtInTool"
  | "running.executingTool.chiAskUser"
  | "running.executingTool.writeAttempt"
  | "done"
  | "terminated.error"
  | "terminated.userCancelled";

export interface Snapshot {
  state: SnapshotState;
  lastAssistantText?: string;
  pendingToolName?: string;
  pendingQuestion?: string;
  tokens?: { input: number; output: number };
  error?: { message: string; cause?: unknown };
}

export interface OrchestratorRun {
  subscribe(listener: (snap: Snapshot) => void): { unsubscribe(): void };
  send(event: { type: "USER_CANCELLED" }): void;
  /** Resolves with the final snapshot once the machine reaches done/terminated. */
  readonly done: Promise<Snapshot>;
}

export interface Orchestrator {
  readonly name: "claude-agent";
  /** Cheap reachability check (verifies ANTHROPIC_API_KEY is set). */
  ping(): Promise<boolean>;
  /** Start a run. Returns a handle the caller subscribes to. */
  start(opts: OrchestratorOptions, prompt: string): OrchestratorRun;
}

/**
 * Thrown by claude-agent.ts at the first query() call when ANTHROPIC_API_KEY
 * is missing. Caught by command code so we surface a friendly hint instead of
 * a stack trace from inside the SDK. CTX-002 Decision #8 + R2.
 */
export class MissingAnthropicKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingAnthropicKeyError";
  }
}
