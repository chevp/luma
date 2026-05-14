import { c } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { readLine } from "../prompt.js";
import { resolveWorkspaceRoot } from "../workspace.js";
import {
  getOrchestrator,
  MissingAnthropicKeyError,
  type PermissionMode,
  type Snapshot,
} from "../orchestrator/index.js";

const HELP = `${BIN_NAME} consult — multi-turn AI consultation with workspace tools.

Usage: ${BIN_NAME} consult [<question>] [options]

Options:
  --write                       allow Edit/Write tools (permissionMode acceptEdits)
  --dangerously-allow-bash      allow Bash tool (permissionMode bypassPermissions; requires --write)
  --model <id>                  override CHI_CLAUDE_MODEL (default claude-opus-4-7)
  --cwd <path>                  override the resolved workspace/repo root
  -h, --help                    show this help

Defaults:
  permissionMode = plan  (read-only — Read/Glob/Grep + chi.* tools)
  cwd            = workspace root if detected, else nearest git repo, else cwd
  model          = \$CHI_CLAUDE_MODEL or claude-opus-4-7

Requires ANTHROPIC_API_KEY (run \`${BIN_NAME} init --provider=claude\` to set it).
`;

interface ParsedArgs {
  question?: string;
  write: boolean;
  allowBash: boolean;
  model?: string;
  cwd?: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { write: false, allowBash: false, showHelp: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.showHelp = true;
    } else if (a === "--write") {
      out.write = true;
    } else if (a === "--dangerously-allow-bash") {
      out.allowBash = true;
    } else if (a === "--model") {
      const v = argv[++i];
      if (!v) throw new Error("--model requires a value");
      out.model = v;
    } else if (a === "--cwd") {
      const v = argv[++i];
      if (!v) throw new Error("--cwd requires a value");
      out.cwd = v;
    } else if (a !== undefined && a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  if (positional.length > 0) out.question = positional.join(" ");
  return out;
}

function pickAllowedTools(write: boolean, allowBash: boolean): string[] {
  const base = ["Read", "Glob", "Grep", "mcp__chi__ask_user", "mcp__chi__plan_list"];
  if (write) base.push("Edit", "Write", "mcp__chi__plan_create");
  if (allowBash) base.push("Bash");
  return base;
}

function pickPermissionMode(write: boolean, allowBash: boolean): PermissionMode {
  if (allowBash) return "bypassPermissions";
  if (write) return "acceptEdits";
  return "plan";
}

export async function run(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${BIN_NAME} consult: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (parsed.showHelp) {
    process.stdout.write(HELP);
    return 0;
  }

  if (parsed.allowBash && !parsed.write) {
    process.stderr.write(
      `${BIN_NAME} consult: --dangerously-allow-bash requires --write (refusing to enable Bash without write)\n`,
    );
    return 1;
  }

  let question = parsed.question;
  if (!question) {
    const answer = await readLine(`${BIN_NAME} consult> `);
    question = (answer ?? "").trim();
    if (!question) {
      process.stderr.write(`${BIN_NAME} consult: no question provided\n`);
      return 1;
    }
  }

  const ws = parsed.cwd
    ? { mode: "repo" as const, root: parsed.cwd }
    : resolveWorkspaceRoot(process.cwd());

  const opts = {
    cwd: ws.root,
    permissionMode: pickPermissionMode(parsed.write, parsed.allowBash),
    allowedTools: pickAllowedTools(parsed.write, parsed.allowBash),
    model: parsed.model ?? process.env.CHI_CLAUDE_MODEL ?? undefined,
  };

  process.stdout.write(
    `${c.dim(`(${ws.mode} mode at ${ws.root}, permission=${opts.permissionMode})`)}\n`,
  );

  const orchestrator = getOrchestrator("claude-agent");

  let run;
  try {
    run = orchestrator.start(opts, question);
  } catch (err) {
    if (err instanceof MissingAnthropicKeyError) {
      process.stderr.write(
        `${BIN_NAME} consult: ANTHROPIC_API_KEY is not set — run \`${BIN_NAME} init --provider=claude\` or export the env var\n`,
      );
      return 1;
    }
    throw err;
  }

  let lastPrintedText = "";
  let lastState = "";
  const sub = run.subscribe((snap: Snapshot) => {
    if (snap.state !== lastState) {
      lastState = snap.state;
      if (snap.state.startsWith("running.executingTool.") && snap.pendingToolName) {
        process.stderr.write(`${c.dim(`→ ${snap.pendingToolName}`)}\n`);
      }
    }
    if (snap.lastAssistantText && snap.lastAssistantText !== lastPrintedText) {
      lastPrintedText = snap.lastAssistantText;
      process.stdout.write(`${snap.lastAssistantText}\n`);
    }
  });

  const final = await run.done;
  sub.unsubscribe();

  if (final.state === "terminated.error") {
    process.stderr.write(
      `${BIN_NAME} consult: ${final.error?.message ?? "orchestrator terminated with error"}\n`,
    );
    return 1;
  }
  if (final.state === "terminated.userCancelled") {
    process.stderr.write(`${BIN_NAME} consult: cancelled\n`);
    return 2;
  }
  return 0;
}
