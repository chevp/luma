import { fromCallback } from "xstate";
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * The single fromCallback actor that pumps the Agent SDK's async iterator
 * into machine events (TEXT, TOOL_USE, RESULT, ERROR). H4 in CTX-002 lives or
 * dies on this file staying small (≤ 40 LoC of glue).
 *
 * `input` is the full options payload passed to `query()` — see CTX-002
 * §System spec for the shape. The actor:
 *   - drives the for-await loop
 *   - emits TEXT for assistant text blocks
 *   - emits TOOL_USE for tool_use blocks (the machine guards on event.name to
 *     route to builtInTool / chiAskUser / writeAttempt)
 *   - emits RESULT once the iterator yields a `result` envelope
 *   - emits ERROR on unexpected throws (network, API, etc.)
 *
 * Cleanup: returning a function from fromCallback ensures USER_CANCELLED /
 * machine stop drops the iterator subscription cleanly. We only flip a flag
 * because the SDK iterator does not currently expose an external abort —
 * setting `cancelled = true` makes the loop bail on its next yield.
 */
export type QueryArgs = Parameters<typeof query>[0];

export const sdkActor = fromCallback<
  | { type: "START" }
  | { type: "TEXT"; text: string }
  | { type: "TOOL_USE"; name: string; id: string }
  | { type: "RESULT"; subtype: string }
  | { type: "ERROR"; error: string },
  QueryArgs
>(({ sendBack, input }) => {
  let cancelled = false;
  void (async () => {
    try {
      for await (const msg of query(input)) {
        if (cancelled) return;
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              sendBack({ type: "TEXT", text: block.text });
            } else if (block.type === "tool_use") {
              sendBack({ type: "TOOL_USE", name: block.name, id: block.id });
            }
          }
        } else if (msg.type === "result") {
          sendBack({ type: "RESULT", subtype: msg.subtype });
        }
      }
      if (!cancelled) sendBack({ type: "RESULT", subtype: "exhausted" });
    } catch (err) {
      if (!cancelled) {
        sendBack({ type: "ERROR", error: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
  return () => {
    cancelled = true;
  };
});
