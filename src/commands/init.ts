import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { c } from "../ui.js";
import { CHI_CONFIG_FILE } from "../config.js";
import { ollamaProvider } from "../provider/ollama.js";
import { commandExists, execInherit } from "../spawn.js";
import { BIN_NAME } from "../identity.js";

const DEFAULT_MODEL = "qwen2.5:7b";

const HELP = `${BIN_NAME} init — provision the local ollama backend.

Usage: ${BIN_NAME} init [options]

What it does:
  1. verifies the 'ollama' binary is installed
  2. checks the ollama daemon is reachable (hints 'ollama serve' if not)
  3. pulls the requested model
  4. pins it as ollama_model in ~/.chi/config

Options:
  --model <name>   model to pull + pin (default: ${DEFAULT_MODEL})
  -h, --help       show this help

Environment (optional):
  CHI_OLLAMA_URL     ollama base URL (default: http://localhost:11434)
  CHI_OLLAMA_MODEL   default model when --model is not given
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

function upsertPairs(updates: Record<string, string>): void {
  const keep = readConfigPairs().filter((p) => !(p.key in updates));
  const merged = [
    ...keep,
    ...Object.entries(updates).map(([key, value]) => ({ key, value })),
  ];
  mkdirSync(dirname(CHI_CONFIG_FILE), { recursive: true });
  const body = merged.map((p) => `${p.key}=${p.value}`).join("\n");
  writeFileSync(CHI_CONFIG_FILE, `${body}${body ? "\n" : ""}`, { mode: 0o600 });
}

export async function run(argv: string[]): Promise<number> {
  let model = process.env.CHI_OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--model") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write(`${BIN_NAME} init: --model requires a value\n`);
        return 1;
      }
      model = v;
      continue;
    }
    if (a !== undefined && a.startsWith("--model=")) {
      model = a.slice("--model=".length);
      continue;
    }
    process.stderr.write(`${BIN_NAME} init: unknown option '${a ?? ""}'\n`);
    return 1;
  }

  const url = process.env.CHI_OLLAMA_URL ?? "http://localhost:11434";
  process.stdout.write(`${BIN_NAME} init — ollama (model: ${model})\n`);

  // 1. binary present?
  if (!commandExists("ollama")) {
    fail("ollama is not installed");
    info("install: https://ollama.com/download");
    return 1;
  }
  ok("ollama binary found");

  // 2. daemon reachable?
  if (await ollamaProvider.ping()) {
    ok(`daemon reachable at ${url}`);
  } else {
    fail(`daemon not reachable at ${url}`);
    info("start it with: ollama serve");
    info("or set CHI_OLLAMA_URL to point at a remote ollama");
    return 1;
  }

  // 3. pull the model (idempotent — ollama skips layers it already has)
  if (await ollamaProvider.hasModel(model)) {
    ok(`model already present: ${model}`);
  } else {
    process.stdout.write(`  ${c.dim(`pulling ${model} …`)}\n`);
    const code = await execInherit("ollama", ["pull", model]);
    if (code !== 0) {
      fail(`ollama pull ${model} failed (exit ${code})`);
      info("check the model name at https://ollama.com/library");
      return 1;
    }
    ok(`pulled ${model}`);
  }

  // 4. pin it so provider auto-selection is deterministic
  upsertPairs({ ollama_model: model });
  ok(`pinned ollama_model=${model} in ${CHI_CONFIG_FILE}`);

  process.stdout.write(`\nready. try: ${BIN_NAME} commit\n`);
  return 0;
}
