import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { c } from "../ui.js";
import { CHI_CONFIG_FILE } from "../config.js";
import { startDeviceLogin } from "../provider/github-copilot-auth.js";
import { claudeProvider } from "../provider/claude.js";
import { BIN_NAME } from "../identity.js";

const HELP = `${BIN_NAME} login — authenticate an LLM provider.

Usage: ${BIN_NAME} login <provider>

Providers:
  claude   authenticate with your GitHub Copilot subscription (OAuth device
           flow) and switch ${BIN_NAME}'s active provider to Claude

Notes:
  The claude provider calls Claude models through GitHub Copilot's chat API,
  not the public Anthropic API. That API is undocumented and intended for
  editor integrations — it requires an active Copilot subscription and may
  change or stop working without notice. Use at your own risk.

  Saves github_copilot_token and provider=claude to ${CHI_CONFIG_FILE}.
  Switch back any time with: ${BIN_NAME} config provider ollama
`;

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

async function loginClaude(): Promise<number> {
  process.stdout.write(`${BIN_NAME} login claude — GitHub Copilot device flow\n\n`);

  let login;
  try {
    login = await startDeviceLogin();
  } catch (err) {
    process.stderr.write(
      `${BIN_NAME} login: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(`  1. open ${c.cyan(login.verificationUri)}\n`);
  process.stdout.write(`  2. enter code: ${c.bold(login.userCode)}\n\n`);
  process.stdout.write(`  waiting for authorization…\n`);

  let token: string;
  try {
    token = await login.waitForToken();
  } catch (err) {
    process.stderr.write(
      `${BIN_NAME} login: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  upsertPairs({ github_copilot_token: token, provider: "claude" });
  process.stdout.write(
    `  ${c.green("✓")} saved github_copilot_token + provider=claude to ${CHI_CONFIG_FILE}\n`,
  );

  process.env.CHI_GITHUB_COPILOT_TOKEN = token;
  process.stdout.write(`  checking Claude model availability…\n`);
  if (await claudeProvider.ping()) {
    process.stdout.write(
      `  ${c.green("✓")} reachable — model: ${c.cyan(claudeProvider.activeModel())}\n`,
    );
  } else {
    process.stdout.write(
      `  ${c.yellow("!")} authenticated, but no Claude model is available via your Copilot plan\n`,
    );
  }

  process.stdout.write(`\nready. try: ${BIN_NAME} commit\n`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const target = argv[0];
  if (target === "-h" || target === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (!target) {
    process.stderr.write(`${BIN_NAME} login: provider required (e.g. '${BIN_NAME} login claude')\n`);
    return 1;
  }
  switch (target) {
    case "claude":
      return loginClaude();
    default:
      process.stderr.write(`${BIN_NAME} login: unknown provider '${target}'\n`);
      return 1;
  }
}
