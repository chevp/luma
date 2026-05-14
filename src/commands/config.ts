import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { CHI_CONFIG_FILE } from "../config.js";
import { execInherit } from "../spawn.js";
import { BIN_NAME } from "../identity.js";

const VALID_KEYS = [
  "llm_url",
  "llm_model",
  "ollama_url",
  "ollama_model",
  "basic_auth_user",
  "basic_auth_password",
  "max_diff_chars",
] as const;
type ValidKey = (typeof VALID_KEYS)[number];

const HELP = `${BIN_NAME} config — view or change persistent settings.

Usage:
  ${BIN_NAME} config                    list saved settings
  ${BIN_NAME} config <key>              show saved value for <key>
  ${BIN_NAME} config <key> <value>      set <key> (validates known keys)
  ${BIN_NAME} config --unset <key>      remove <key> from saved settings
  ${BIN_NAME} config edit               open the config file in $EDITOR
  ${BIN_NAME} config path               print the config file path

Keys:
  llm_url               cura endpoint URL              (default: https://cura-llm-3j2fyuwcdq-oa.a.run.app)
  llm_model             cura model name                (default: smollm2:135m)
  ollama_url            local ollama endpoint          (default: http://localhost:11434)
  ollama_model          local ollama model name        (default: first non-embedding model from 'ollama list')
  basic_auth_user       cura basic-auth username       (REQUIRED)
  basic_auth_password   cura basic-auth password       (REQUIRED)
  max_diff_chars        diff truncation length         (default: 8000)

Examples:
  ${BIN_NAME} config basic_auth_user my-user
  ${BIN_NAME} config basic_auth_password my-secret
  ${BIN_NAME} config llm_model smollm2:135m

Notes:
  Settings are saved to ${CHI_CONFIG_FILE}.
  Explicit env vars still win, so a one-off
    BASIC_AUTH_USER=u BASIC_AUTH_PASSWORD=p ${BIN_NAME} commit
  overrides whatever was saved here.
`;

function isValidKey(s: string): s is ValidKey {
  return (VALID_KEYS as ReadonlyArray<string>).includes(s);
}

function validateValue(key: ValidKey, value: string): string | null {
  switch (key) {
    case "max_diff_chars":
      if (!/^\d+$/.test(value)) {
        return `${BIN_NAME} config: max_diff_chars must be a positive integer`;
      }
      return null;
    case "llm_url":
    case "ollama_url":
      if (!/^https?:\/\//.test(value)) {
        return `${BIN_NAME} config: ${key} must start with http:// or https://`;
      }
      return null;
    default:
      return null;
  }
}

interface Pair {
  key: string;
  value: string;
  raw: string;
}

function readPairs(): Pair[] {
  if (!existsSync(CHI_CONFIG_FILE)) return [];
  const raw = readFileSync(CHI_CONFIG_FILE, "utf8");
  const out: Pair[] = [];
  for (const ln of raw.split(/\r?\n/)) {
    const trimmed = ln.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).replace(/^\s+/, "");
    out.push({ key, value, raw: ln });
  }
  return out;
}

function writePairs(pairs: Pair[]): void {
  mkdirSync(dirname(CHI_CONFIG_FILE), { recursive: true });
  const body = pairs.map((p) => `${p.key}=${p.value}`).join("\n");
  writeFileSync(CHI_CONFIG_FILE, `${body}${body ? "\n" : ""}`);
}

function listAll(): number {
  if (!existsSync(CHI_CONFIG_FILE)) {
    process.stdout.write(`(no settings — config file does not exist: ${CHI_CONFIG_FILE})\n`);
    return 0;
  }
  const raw = readFileSync(CHI_CONFIG_FILE, "utf8");
  for (const ln of raw.split(/\r?\n/)) {
    const trimmed = ln.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    process.stdout.write(`${ln}\n`);
  }
  return 0;
}

function readValue(key: string): string | null {
  for (const p of readPairs()) {
    if (p.key === key) return p.value;
  }
  return null;
}

function setValue(key: string, value: string): void {
  const pairs = readPairs().filter((p) => p.key !== key);
  pairs.push({ key, value, raw: `${key}=${value}` });
  writePairs(pairs);
}

function unsetValue(key: string): void {
  if (!existsSync(CHI_CONFIG_FILE)) return;
  const pairs = readPairs().filter((p) => p.key !== key);
  writePairs(pairs);
}

export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "list";
  const rest = argv.slice(1);

  switch (cmd) {
    case "list":
      return listAll();
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "path":
      process.stdout.write(`${CHI_CONFIG_FILE}\n`);
      return 0;
    case "edit": {
      mkdirSync(dirname(CHI_CONFIG_FILE), { recursive: true });
      if (!existsSync(CHI_CONFIG_FILE)) writeFileSync(CHI_CONFIG_FILE, "");
      const editor = process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      return execInherit(editor, [CHI_CONFIG_FILE]);
    }
    case "--unset": {
      const k = rest[0];
      if (!k) {
        process.stderr.write(`${BIN_NAME} config: --unset requires a key\n`);
        return 1;
      }
      if (!isValidKey(k)) {
        process.stderr.write(`${BIN_NAME} config: unknown key '${k}' (run '${BIN_NAME} config --help')\n`);
        return 1;
      }
      unsetValue(k);
      process.stdout.write(`unset ${k}\n`);
      return 0;
    }
    default: {
      if (!isValidKey(cmd)) {
        process.stderr.write(`${BIN_NAME} config: unknown key '${cmd}' (run '${BIN_NAME} config --help')\n`);
        return 1;
      }
      if (rest.length === 0) {
        const v = readValue(cmd);
        if (v) {
          process.stdout.write(`${v}\n`);
        } else {
          process.stdout.write(`(unset — using default; see '${BIN_NAME} status' for active value)\n`);
        }
        return 0;
      }
      const value = rest[0]!;
      const err = validateValue(cmd, value);
      if (err) {
        process.stderr.write(`${err}\n`);
        return 1;
      }
      setValue(cmd, value);
      process.stdout.write(`${cmd}=${value}\n`);
      return 0;
    }
  }
}
