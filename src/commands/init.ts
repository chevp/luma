import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { c } from "../ui.js";
import { CHI_CONFIG_FILE } from "../config.js";
import { curaProvider } from "../provider/cura.js";
import { BIN_NAME } from "../identity.js";
import { readLine, readSecret } from "../prompt.js";

const HELP = `${BIN_NAME} init — set up provider credentials.

Usage: ${BIN_NAME} init [options]

What it does (default — cura provider):
  1. prompts for BASIC_AUTH_USER / BASIC_AUTH_PASSWORD if not already set
  2. saves them to ~/.chi/config (chmod 600)
  3. pings the cura endpoint
  4. confirms the configured model is available

What it does (--provider=claude):
  1. prompts for ANTHROPIC_API_KEY if not already set
  2. saves it to ~/.chi/config (chmod 600)
  3. verifies the orchestrator can be loaded

Options:
  --provider <cura|claude>  which provider to configure (default: cura)
  --force                   re-prompt even if credentials are already set
  -h, --help                show this help

Environment (optional):
  CHI_LLM_URL        override the default cura URL
  CHI_LLM_MODEL      override the default cura model (default: smollm2:135m)
  CHI_CLAUDE_MODEL   override the default claude model (default: claude-opus-4-7)
`;

function ok(msg: string): void {
  process.stdout.write(`  ${c.green("✓")} ${msg}\n`);
}
function fail(msg: string): void {
  process.stdout.write(`  ${c.red("✗")} ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`    ${c.dim(msg)}\n`);
}

interface Pair {
  key: string;
  value: string;
}

function readConfigPairs(): Pair[] {
  if (!existsSync(CHI_CONFIG_FILE)) return [];
  const raw = readFileSync(CHI_CONFIG_FILE, "utf8");
  const out: Pair[] = [];
  for (const ln of raw.split(/\r?\n/)) {
    const trimmed = ln.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out.push({
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).replace(/^\s+/, ""),
    });
  }
  return out;
}

function writeConfigPairs(pairs: Pair[]): void {
  mkdirSync(dirname(CHI_CONFIG_FILE), { recursive: true });
  const body = pairs.map((p) => `${p.key}=${p.value}`).join("\n");
  writeFileSync(CHI_CONFIG_FILE, `${body}${body ? "\n" : ""}`, { mode: 0o600 });
}

function upsertPairs(updates: Record<string, string>): void {
  const keep = readConfigPairs().filter((p) => !(p.key in updates));
  const merged = [
    ...keep,
    ...Object.entries(updates).map(([key, value]) => ({ key, value })),
  ];
  writeConfigPairs(merged);
}

async function promptCredentials(force: boolean): Promise<{ user: string; password: string } | null> {
  const persisted = Object.fromEntries(readConfigPairs().map((p) => [p.key, p.value]));

  const existingUser =
    process.env.BASIC_AUTH_USER ||
    persisted.basic_auth_user ||
    "";
  const existingPassword =
    process.env.BASIC_AUTH_PASSWORD ||
    persisted.basic_auth_password ||
    "";

  if (!force && existingUser && existingPassword) {
    info("credentials already set — pass --force to re-prompt");
    return { user: existingUser, password: existingPassword };
  }

  if (!process.stdin.isTTY) {
    fail("not a TTY — cannot prompt for credentials");
    info("set BASIC_AUTH_USER / BASIC_AUTH_PASSWORD in env, or run interactively");
    return null;
  }

  process.stdout.write("\n");
  const userPrompt = existingUser ? `BASIC_AUTH_USER [${existingUser}]: ` : "BASIC_AUTH_USER: ";
  const userIn = await readLine(userPrompt);
  const user = (userIn ?? "").trim() || existingUser;
  if (!user) {
    fail("BASIC_AUTH_USER is required");
    return null;
  }

  const passwordIn = await readSecret("BASIC_AUTH_PASSWORD: ");
  const password = passwordIn ?? "";
  if (!password) {
    if (existingPassword) {
      info("(empty input — keeping existing password)");
      return { user, password: existingPassword };
    }
    fail("BASIC_AUTH_PASSWORD is required");
    return null;
  }

  return { user, password };
}

async function promptAnthropicKey(force: boolean): Promise<string | null> {
  const persisted = Object.fromEntries(readConfigPairs().map((p) => [p.key, p.value]));
  const existing = process.env.ANTHROPIC_API_KEY || persisted.anthropic_api_key || "";

  if (!force && existing) {
    info("ANTHROPIC_API_KEY already set — pass --force to re-prompt");
    return existing;
  }

  if (!process.stdin.isTTY) {
    fail("not a TTY — cannot prompt for ANTHROPIC_API_KEY");
    info("set ANTHROPIC_API_KEY in env, or run interactively");
    return null;
  }

  process.stdout.write("\n");
  const keyIn = await readSecret("ANTHROPIC_API_KEY: ");
  const key = (keyIn ?? "").trim();
  if (!key) {
    if (existing) {
      info("(empty input — keeping existing key)");
      return existing;
    }
    fail("ANTHROPIC_API_KEY is required");
    return null;
  }
  return key;
}

async function runClaude(force: boolean): Promise<number> {
  const model = process.env.CHI_CLAUDE_MODEL ?? "claude-opus-4-7";
  process.stdout.write(`chi init — claude (model: ${model})\n`);

  const key = await promptAnthropicKey(force);
  if (!key) return 1;

  upsertPairs({ anthropic_api_key: key });
  process.env.ANTHROPIC_API_KEY = key;
  ok(`saved ANTHROPIC_API_KEY to ${CHI_CONFIG_FILE}`);

  // Lazy-load so this command does not pay the SDK import cost when only
  // the cura branch runs (CTX-002 #8 / ADR-008 §Decision rule 2).
  let orchestrator;
  try {
    const mod = await import("../orchestrator/index.js");
    orchestrator = mod.getOrchestrator("claude-agent");
  } catch (err) {
    fail(`failed to load orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (await orchestrator.ping()) {
    ok("orchestrator reachable (key present)");
  } else {
    fail("orchestrator ping failed");
    return 1;
  }

  process.stdout.write(`\nready. try: ${BIN_NAME} consult "summarize the README"\n`);
  return 0;
}

async function runCura(force: boolean): Promise<number> {
  const url = process.env.CHI_LLM_URL ?? "https://cura-llm-3j2fyuwcdq-oa.a.run.app";
  const model = curaProvider.activeModel();

  process.stdout.write(`chi init — cura (model: ${model})\n`);

  const creds = await promptCredentials(force);
  if (!creds) return 1;

  upsertPairs({
    basic_auth_user: creds.user,
    basic_auth_password: creds.password,
  });
  process.env.BASIC_AUTH_USER = creds.user;
  process.env.BASIC_AUTH_PASSWORD = creds.password;
  ok(`saved credentials to ${CHI_CONFIG_FILE}`);

  if (await curaProvider.ping()) {
    ok(`endpoint reachable at ${url}`);
  } else {
    fail(`endpoint not reachable at ${url}`);
    info(`check network and credentials, then re-run '${BIN_NAME} init --force'`);
    return 1;
  }

  if (await curaProvider.hasModel(model)) {
    ok(`model available: ${model}`);
  } else {
    fail(`model not available: ${model}`);
    info(`set CHI_LLM_MODEL to one offered by ${url}/api/tags`);
    return 1;
  }

  process.stdout.write("\nready. try: chi commit\n");
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  let force = false;
  let provider: "cura" | "claude" = "cura";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--provider") {
      const v = argv[++i];
      if (v !== "cura" && v !== "claude") {
        process.stderr.write(`chi init: --provider expects 'cura' or 'claude' (got '${v ?? ""}')\n`);
        return 1;
      }
      provider = v;
      continue;
    }
    if (a !== undefined && a.startsWith("--provider=")) {
      const v = a.slice("--provider=".length);
      if (v !== "cura" && v !== "claude") {
        process.stderr.write(`chi init: --provider expects 'cura' or 'claude' (got '${v}')\n`);
        return 1;
      }
      provider = v;
      continue;
    }
    process.stderr.write(`chi init: unknown option '${a ?? ""}'\n`);
    return 1;
  }

  return provider === "claude" ? runClaude(force) : runCura(force);
}
