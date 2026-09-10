import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseYaml } from "./yaml.js";
import { resolveWorkspaceRoot } from "./workspace.js";
const GROUPS = ["sdk", "tools"];
const CONFIG_EXAMPLE = `sdk:
  cmake: latest
  vulkan: latest
  java: "21"
  android: latest
  blender: "4.6"
  node: "24"
  ollama: true
tools:
  vscode: true
  git: true`;
export function toolchainConfigPath(workspaceRoot) {
    const override = process.env.LUMA_TOOLCHAIN_FILE;
    if (!override)
        return join(workspaceRoot, ".luma", "toolchain.yml");
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
}
/** Resolve, read and validate the toolchain manifest. Throws on any problem. */
export function loadToolchainConfig() {
    const workspaceRoot = resolveWorkspaceRoot().root;
    const configPath = toolchainConfigPath(workspaceRoot);
    if (!existsSync(configPath)) {
        throw new Error(`no toolchain manifest found at ${configPath}\n` +
            `Create it to declare the tools this machine should have, e.g.:\n\n${CONFIG_EXAMPLE}\n`);
    }
    let parsed;
    try {
        parsed = parseYaml(readFileSync(configPath, "utf8"));
    }
    catch (err) {
        throw new Error(`${configPath}: invalid YAML — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${configPath}: expected a top-level mapping with "sdk"/"tools" keys`);
    }
    const doc = parsed;
    for (const key of Object.keys(doc)) {
        if (!GROUPS.includes(key)) {
            throw new Error(`${configPath}: unknown top-level key "${key}" (valid: ${GROUPS.join(", ")})`);
        }
    }
    const entries = [];
    const seen = new Set();
    for (const group of GROUPS) {
        const raw = doc[group];
        if (raw === undefined)
            continue;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new Error(`${configPath}: "${group}" must be a mapping of tool -> version`);
        }
        for (const [id, value] of Object.entries(raw)) {
            if (seen.has(id)) {
                throw new Error(`${configPath}: duplicate tool "${id}"`);
            }
            seen.add(id);
            const desired = normalizeDesired(value, configPath, id);
            entries.push({ id, group, desired });
        }
    }
    if (entries.length === 0) {
        throw new Error(`${configPath}: no tools declared under "sdk" or "tools"`);
    }
    return { workspaceRoot, configPath, entries };
}
function normalizeDesired(value, configPath, id) {
    if (value === true)
        return true;
    if (typeof value === "string") {
        return value.trim().toLowerCase() === "latest" ? true : value.trim();
    }
    throw new Error(`${configPath}: tool "${id}" must be a version string or true, got ${JSON.stringify(value)}`);
}
/** Pick the entries named on the command line, or all of them when none given. */
export function selectEntries(entries, names) {
    if (names.length === 0)
        return entries;
    const byId = new Map(entries.map((e) => [e.id, e]));
    const chosen = [];
    for (const n of names) {
        const e = byId.get(n);
        if (!e) {
            const known = entries.map((x) => x.id).join(", ");
            throw new Error(`unknown tool '${n}' (known: ${known})`);
        }
        chosen.push(e);
    }
    return chosen;
}
//# sourceMappingURL=toolchain.js.map