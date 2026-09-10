import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BIN_NAME } from "../identity.js";
import { c, line, section, sym } from "../ui.js";
import { commandExists, execInherit } from "../spawn.js";
import { resolveWorkspaceRoot } from "../workspace.js";

/**
 * `luma up` / `luma down` — bring the workspace's Docker stacks up or down.
 *
 * Discovery is an explicit allowlist, NOT a blanket scan: the workspace has
 * dozens of docker-compose files (nested service fragments, deployment
 * templates, build-only variants, a mirrored nested workspace, a broken cura
 * pointer on Windows). Auto-starting all of them would double-start shared
 * services (e.g. `kaga`) and run things that were never meant to run locally.
 * So the stacks are curated in `.luma/stacks.json` at the workspace root; each
 * entry runs as its own compose project (`docker compose -p <name>`) which
 * keeps networks, volumes and the service namespace isolated.
 *
 * Config (`<workspace-root>/.luma/stacks.json`, override with LUMA_STACKS_FILE):
 *   {
 *     "stacks": [
 *       { "name": "cura",   "repo": "misc/cura",  "file": "docker-compose.local.yml",
 *         "env": { "OLLAMA_PORT": "11435" } },
 *       { "name": "kosmos", "repo": "apps/kosmos", "file": "docker-compose.yml" }
 *     ]
 *   }
 *
 * Optional per-stack `env` is merged over the process environment for that
 * stack's `docker compose` invocation only — used e.g. to move a published
 * host port when a native service already owns it (cura's ollama vs a local
 * ollama both wanting 11434).
 */

interface Stack {
  /** Compose project name (`docker compose -p`). Unique. */
  name: string;
  /** Repo path relative to the workspace root. */
  repo: string;
  /** Compose file relative to the repo. Defaults to docker-compose.yml. */
  file: string;
  /** Extra env vars for this stack's compose invocation (merged over process env). */
  env?: Record<string, string>;
}

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
    { "name": "cura",   "repo": "misc/cura",  "file": "docker-compose.local.yml",
      "env": { "OLLAMA_PORT": "11435" } },
    { "name": "kosmos", "repo": "apps/kosmos", "file": "docker-compose.yml" }
  ]
}`;

interface LoadedConfig {
  workspaceRoot: string;
  configPath: string;
  stacks: Stack[];
}

/** Resolve, read and validate the stacks allowlist. Throws on any problem. */
function loadConfig(): LoadedConfig {
  const workspaceRoot = resolveWorkspaceRoot().root;
  const override = process.env.LUMA_STACKS_FILE;
  const configPath = override
    ? isAbsolute(override)
      ? override
      : resolve(process.cwd(), override)
    : join(workspaceRoot, ".luma", "stacks.json");

  if (!existsSync(configPath)) {
    throw new Error(
      `no stacks config found at ${configPath}\n` +
        `Create it with an allowlist of the stacks to manage, e.g.:\n\n${CONFIG_EXAMPLE}\n`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`${configPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawStacks = (parsed as { stacks?: unknown })?.stacks;
  if (!Array.isArray(rawStacks)) {
    throw new Error(`${configPath}: expected a top-level "stacks" array`);
  }

  const stacks: Stack[] = [];
  const seen = new Set<string>();
  rawStacks.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    const repo = typeof e?.repo === "string" ? e.repo.trim() : "";
    const file = typeof e?.file === "string" && e.file.trim() ? e.file.trim() : DEFAULT_FILE;
    if (!name) throw new Error(`${configPath}: stacks[${i}] is missing "name"`);
    if (!repo) throw new Error(`${configPath}: stack '${name}' is missing "repo"`);
    if (seen.has(name)) throw new Error(`${configPath}: duplicate stack name '${name}'`);
    seen.add(name);

    let env: Record<string, string> | undefined;
    if (e?.env !== undefined) {
      if (typeof e.env !== "object" || e.env === null || Array.isArray(e.env)) {
        throw new Error(`${configPath}: stack '${name}' has an "env" that is not an object`);
      }
      env = {};
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new Error(`${configPath}: stack '${name}' env '${k}' must be a string`);
        }
        env[k] = v;
      }
    }

    stacks.push({ name, repo, file, env });
  });

  if (stacks.length === 0) {
    throw new Error(`${configPath}: "stacks" is empty — nothing to manage`);
  }

  return { workspaceRoot, configPath, stacks };
}

/** Pick the stacks named on the command line, or all of them when none given. */
function select(stacks: Stack[], names: string[]): Stack[] {
  if (names.length === 0) return stacks;
  const byName = new Map(stacks.map((s) => [s.name, s]));
  const chosen: Stack[] = [];
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

function composeFile(root: string, s: Stack): string {
  return join(root, s.repo, s.file);
}

async function execStacks(action: "up" | "down", argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === "-h" || first === "--help") {
    process.stdout.write(action === "up" ? UP_HELP : DOWN_HELP);
    return 0;
  }

  const names: string[] = [];
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
        if (arg.startsWith("-")) throw new Error(`unknown option '${arg}'`);
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
      process.stderr.write(
        `${c.red(sym.err)} ${s.name}: compose file not found: ${composeFile(workspaceRoot, s)}\n`,
      );
    }
    return 1;
  }

  // `down` in reverse so dependents stop before what they lean on.
  if (action === "down") selected = [...selected].reverse();

  section(action === "up" ? "starting stacks" : "stopping stacks");
  for (const s of selected) {
    process.stdout.write(`  ${sym.arrow} ${c.bold(s.name)} ${c.dim(`(${s.repo}/${s.file})`)}\n`);
  }
  line();

  const failed: Array<{ name: string; code: number }> = [];
  for (const s of selected) {
    const composeArgs = ["compose", "-p", s.name, "-f", composeFile(workspaceRoot, s)];
    if (action === "up") {
      composeArgs.push("up");
      if (!attach) composeArgs.push("-d");
      if (build) composeArgs.push("--build");
    } else {
      composeArgs.push("down");
      if (volumes) composeArgs.push("-v");
    }
    const envPrefix = s.env
      ? Object.entries(s.env).map(([k, v]) => `${k}=${v} `).join("")
      : "";
    process.stdout.write(`${c.dim(`$ ${envPrefix}docker ${composeArgs.join(" ")}`)}\n`);
    const env = s.env ? { ...process.env, ...s.env } : process.env;
    const code = await execInherit("docker", composeArgs, { env });
    if (code !== 0) failed.push({ name: s.name, code });
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
  process.stdout.write(
    `${c.green(sym.ok)} ${verb} ${selected.length} stack${selected.length === 1 ? "" : "s"}: ${selected
      .map((s) => s.name)
      .join(", ")}\n`,
  );
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  return execStacks("up", argv);
}

export async function down(argv: string[]): Promise<number> {
  return execStacks("down", argv);
}
