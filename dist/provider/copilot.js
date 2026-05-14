import { commandExists, execAsync } from "../spawn.js";
export const copilotProvider = {
    name: "copilot",
    activeModel() {
        return "copilot (CLI-managed)";
    },
    async ping() {
        return commandExists("copilot");
    },
    async hasModel() {
        return true;
    },
    async generate(prompt) {
        if (!commandExists("copilot")) {
            throw new Error("copilot CLI not on PATH");
        }
        const r = await execAsync("copilot", ["-p", "--allow-all-tools"], { input: prompt });
        if (!r.ok) {
            throw new Error(r.stderr.trim() || `copilot exited with status ${r.status}`);
        }
        return r.stdout;
    },
};
//# sourceMappingURL=copilot.js.map