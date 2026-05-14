import { fromCallback } from "xstate";
import { query } from "@anthropic-ai/claude-agent-sdk";
export const sdkActor = fromCallback(({ sendBack, input }) => {
    let cancelled = false;
    void (async () => {
        try {
            for await (const msg of query(input)) {
                if (cancelled)
                    return;
                if (msg.type === "assistant") {
                    for (const block of msg.message.content) {
                        if (block.type === "text") {
                            sendBack({ type: "TEXT", text: block.text });
                        }
                        else if (block.type === "tool_use") {
                            sendBack({ type: "TOOL_USE", name: block.name, id: block.id });
                        }
                    }
                }
                else if (msg.type === "result") {
                    sendBack({ type: "RESULT", subtype: msg.subtype });
                }
            }
            if (!cancelled)
                sendBack({ type: "RESULT", subtype: "exhausted" });
        }
        catch (err) {
            if (!cancelled) {
                sendBack({ type: "ERROR", error: err instanceof Error ? err.message : String(err) });
            }
        }
    })();
    return () => {
        cancelled = true;
    };
});
//# sourceMappingURL=sdk-actor.js.map