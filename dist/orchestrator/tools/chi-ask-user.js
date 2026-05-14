import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
/**
 * The mcp__chi__ask_user tool. Bounces a question out to the human via the
 * AskUserHandler injected from the consult command, then returns their
 * verbatim answer as a tool_result block.
 */
export function makeAskUserTool(handler) {
    return tool("ask_user", "Ask the human a clarifying question and return their answer verbatim. Use this whenever the requested information is not derivable from the workspace (e.g. user identity, missing context, or a yes/no decision the human must make).", {
        question: z.string().describe("The question to display to the user."),
        options: z
            .array(z.string())
            .optional()
            .describe("Optional list of pre-selected answers to display."),
    }, async ({ question, options }) => {
        const answer = await handler.prompt(question, options);
        return { content: [{ type: "text", text: answer }] };
    });
}
//# sourceMappingURL=chi-ask-user.js.map