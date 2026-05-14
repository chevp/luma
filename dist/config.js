import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const CHI_CONFIG_FILE = process.env.CHI_CONFIG_FILE ?? join(homedir(), ".chi", "config");
const KEY_TO_ENV = {
    llm_url: "CHI_LLM_URL",
    llm_model: "CHI_LLM_MODEL",
    ollama_url: "CHI_OLLAMA_URL",
    ollama_model: "CHI_OLLAMA_MODEL",
    basic_auth_user: "BASIC_AUTH_USER",
    basic_auth_password: "BASIC_AUTH_PASSWORD",
    max_diff_chars: "CHI_MAX_DIFF_CHARS",
    // Claude orchestrator (CTX-002). Loading these is unconditional; whether the
    // key is *required* is decided at the first orchestrator query() call, not
    // at boot — so commands like `chi status` / `chi commit` keep working when
    // only cura credentials are set.
    anthropic_api_key: "ANTHROPIC_API_KEY",
    claude_model: "CHI_CLAUDE_MODEL",
    claude_permission_mode: "CHI_CLAUDE_PERMISSION_MODE",
};
/**
 * Loads ~/.chi/config. Existing env vars win over the file (explicit env >
 * saved config > built-in default).
 */
export function loadPersistedConfig() {
    if (!existsSync(CHI_CONFIG_FILE))
        return;
    const raw = readFileSync(CHI_CONFIG_FILE, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0)
            continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trimStart();
        const envName = KEY_TO_ENV[key];
        if (!envName)
            continue;
        if (process.env[envName] === undefined || process.env[envName] === "") {
            process.env[envName] = value;
        }
    }
}
//# sourceMappingURL=config.js.map