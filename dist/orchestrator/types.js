/**
 * Public types for the Orchestrator layer (CTX-002 §System spec).
 *
 * This file intentionally does NOT import xstate or
 * @anthropic-ai/claude-agent-sdk — it is the boundary that command code
 * (src/commands/consult.ts, src/commands/plan.ts, future chi gate/approve)
 * subscribes to. See ADR-008 §Decision rule 1.
 */
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
//# sourceMappingURL=types.js.map