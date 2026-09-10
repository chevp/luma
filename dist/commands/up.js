import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BIN_NAME } from "../identity.js";
import { c, line, section, sym } from "../ui.js";
import { commandExists, execInherit } from "../spawn.js";
import { resolveWorkspaceRoot } from "../workspace.js";
const DEFAULT_FILE = "docker-compose.yml";
const UP_HELP = `${BIN_NAME} up — start the workspace Docker stacks (detached).

Usage: ${BIN_NAME} up [stack...] [options]

Arguments:
  stack         one or more stack names from .luma/stacks.json (default: all)

Options:
  --build       rebuild images before starting
  --attach      stream logs in the foreground instead of detaching
  -h, --help    show this help

Stacks are read from <workspace-root>/.luma/stacks.json
(override the path with LUMA_STACKS_FILE).
`;
const DOWN_HELP = `${BIN_NAME} down — stop the workspace Docker stacks.

Usage: ${BIN_NAME} down [stack...] [options]

Arguments:
  stack           one or more stack names from .luma/stacks.json (default: all)

Options:
  -v, --volumes   also remove named volumes (docker compose down -v)
  -h, --help      show this help
`;
const CONFIG_EXAMPLE = `{
  "stacks": [
    { "name": "cura",   "repo": "misc/cura",  "file": "docker-compose.local.yml" },
    { "name": "kosmos", "repo": "apps/kosmos", "file": "docker-compose.yml" }
  ]
}`;
/** Resolve, read and validate the stacks allowlist. Throws on any problem. */
function loadConfig() {
    const workspaceRoot = resolveWorkspaceRoot().root;
    const override = process.env.LUMA_STACKS_FILE;
    const configPath = override
        ? isAbsolute(override)
            ? override
            : resolve(process.cwd(), override)
        : join(workspaceRoot, ".luma", "stacks.json");
    if (!existsSync(configPath)) {
        throw new Error(`no stacks config found at ${configPath}\n` +
            `Create it with an allowlist of the stacks to manage, e.g.:\n\n${CONFIG_EXAMPLE}\n`);
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch (err) {
        throw new Error(`${configPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    const rawStacks = parsed?.stacks;
    if (!Array.isArray(rawStacks)) {
        throw new Error(`${configPath}: expected a top-level "stacks" array`);
    }
    const stacks = [];
    const seen = new Set();
    rawStacks.forEach((entry, i) => {
        const e = entry;
        const name = typeof e?.name === "string" ? e.name.trim() : "";
        const repo = typeof e?.repo === "string" ? e.repo.trim() : "";
        const file = typeof e?.file === "string" && e.file.trim() ? e.file.trim() : DEFAULT_FILE;
        if (!name)
            throw new Error(`${configPath}: stacks[${i}] is missing "name"`);
        if (!repo)
            throw new Error(`${configPath}: stack '${name}' is missing "repo"`);
        if (seen.has(name))
            throw new Error(`${configPath}: duplicate stack name '${name}'`);
        seen.add(name);
        stacks.push({ name, repo, file });
    });
    if (stacks.length === 0) {
        throw new Error(`${configPath}: "stacks" is empty — nothing to manage`);
    }
    return { workspaceRoot, configPath, stacks };
}
/** Pick the stacks named on the command line, or all of them when none given. */
function select(stacks, names) {
    if (names.length === 0)
        return stacks;
    const byName = new Map(stacks.map((s) => [s.name, s]));
    const chosen = [];
    for (const n of names) {
        const s = byName.get(n);
        if (!s) {
            const known = stacks.map((x) => x.name).join(", ");
            throw new Error(`unknown stack '${n}' (known: ${known})`);
        }
        chosen.push(s);
    }
    return chosen;
}
function composeFile(root, s) {
    return join(root, s.repo, s.file);
}
async function execStacks(action, argv) {
    const first = argv[0];
    if (first === "-h" || first === "--help") {
        process.stdout.write(action === "up" ? UP_HELP : DOWN_HELP);
        return 0;
    }
    const names = [];
    let build = false;
    let attach = false;
    let volumes = false;
    for (const arg of argv) {
        switch (arg) {
            case "--build":
                build = true;
                break;
            case "--attach":
                attach = true;
                break;
            case "-v":
            case "--volumes":
                volumes = true;
                break;
            default:
                if (arg.startsWith("-"))
                    throw new Error(`unknown option '${arg}'`);
                names.push(arg);
        }
    }
    if (!commandExists("docker")) {
        throw new Error("docker not found on PATH — install Docker (Compose v2 plugin required)");
    }
    const { workspaceRoot, stacks } = loadConfig();
    let selected = select(stacks, names);
    // Fail before touching Docker if any compose file is missing on disk.
    const missing = selected.filter((s) => !existsSync(composeFile(workspaceRoot, s)));
    if (missing.length > 0) {
        for (const s of missing) {
            process.stderr.write(`${c.red(sym.err)} ${s.name}: compose file not found: ${composeFile(workspaceRoot, s)}\n`);
        }
        return 1;
    }
    // `down` in reverse so dependents stop before what they lean on.
    if (action === "down")
        selected = [...selected].reverse();
    section(action === "up" ? "starting stacks" : "stopping stacks");
    for (const s of selected) {
        process.stdout.write(`  ${sym.arrow} ${c.bold(s.name)} ${c.dim(`(${s.repo}/${s.file})`)}\n`);
    }
    line();
    const failed = [];
    for (const s of selected) {
        const composeArgs = ["compose", "-p", s.name, "-f", composeFile(workspaceRoot, s)];
        if (action === "up") {
            composeArgs.push("up");
            if (!attach)
                composeArgs.push("-d");
            if (build)
                composeArgs.push("--build");
        }
        else {
            composeArgs.push("down");
            if (volumes)
                composeArgs.push("-v");
        }
        process.stdout.write(`${c.dim(`$ docker ${composeArgs.join(" ")}`)}\n`);
        const code = await execInherit("docker", composeArgs);
        if (code !== 0)
            failed.push({ name: s.name, code });
    }
    line();
    if (failed.length > 0) {
        section("failed");
        for (const f of failed) {
            process.stdout.write(`  ${c.red(sym.err)} ${f.name} ${c.dim(`(exit ${f.code})`)}\n`);
        }
        return 1;
    }
    const verb = action === "up" ? "started" : "stopped";
    process.stdout.write(`${c.green(sym.ok)} ${verb} ${selected.length} stack${selected.length === 1 ? "" : "s"}: ${selected
        .map((s) => s.name)
        .join(", ")}\n`);
    return 0;
}
export async function run(argv) {
    return execStacks("up", argv);
}
export async function down(argv) {
    return execStacks("down", argv);
}
//# sourceMappingURL=up.js.map