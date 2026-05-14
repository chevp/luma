import { createInterface } from "node:readline";
/**
 * Default AskUserHandler — readline-based terminal Q&A. Used by the
 * mcp__chi__ask_user tool to bounce questions out to the human and read the
 * answer back. Pluggable via OrchestratorOptions.askUser so workflow YAML or
 * tests can stub it.
 */
export const readlineAskUser = {
    async prompt(question, options) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error("chi.ask_user invoked without a TTY — pass an AskUserHandler in OrchestratorOptions or run interactively");
        }
        const banner = options?.length
            ? `\n${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}\n> `
            : `\n${question}\n> `;
        return await new Promise((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(banner, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    },
};
//# sourceMappingURL=ask-user.js.map