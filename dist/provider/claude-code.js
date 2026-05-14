import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandExists, execAsync } from "../spawn.js";
function isExecutionError(out) {
    return out.replace(/\s+/g, "") === "Executionerror";
}
/**
 * Repair a known recurring corruption of
 * ~/.claude/plugins/installed_plugins.json where each entry is wrapped in a
 * single-element array but Claude Code's Zod schema expects a plain object.
 * Returns true when a repair was made.
 */
function repairPluginsFile() {
    const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(path))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return false;
    }
    if (!parsed || typeof parsed !== "object")
        return false;
    const root = parsed;
    const plugins = root.plugins;
    if (!plugins || typeof plugins !== "object")
        return false;
    let changed = false;
    for (const [k, v] of Object.entries(plugins)) {
        if (Array.isArray(v) && v.length === 1 && typeof v[0] === "object" && v[0] !== null) {
            plugins[k] = v[0];
            changed = true;
        }
    }
    if (!changed)
        return false;
    try {
        copyFileSync(path, `${path}.bak`);
        writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}
async function callClaude(prompt) {
    const r = await execAsync("claude", ["-p"], { input: prompt });
    if (!r.ok) {
        const msg = r.stderr.trim() || `claude exited with status ${r.status}`;
        throw new Error(msg);
    }
    return r.stdout;
}
export const claudeCodeProvider = {
    name: "claude-code",
    activeModel() {
        return "claude-code (CLI-managed)";
    },
    async ping() {
        return commandExists("claude");
    },
    async hasModel() {
        return true;
    },
    async generate(prompt) {
        if (!commandExists("claude")) {
            throw new Error("claude CLI not on PATH");
        }
        let out = await callClaude(prompt);
        if (isExecutionError(out)) {
            if (repairPluginsFile()) {
                process.stderr.write("claude-code: repaired malformed ~/.claude/plugins/installed_plugins.json (backup at .bak), retrying\n");
                out = await callClaude(prompt);
            }
            if (isExecutionError(out)) {
                throw new Error('claude CLI returned "Execution error" — run \'claude -p --output-format json "hi"\' to inspect the underlying error');
            }
        }
        return out;
    },
};
//# sourceMappingURL=claude-code.js.map