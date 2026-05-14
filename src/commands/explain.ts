import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  activeProviderName,
  getProvider,
  providerEnsureRunning,
} from "../provider/index.js";
import { git, gitDir, isInsideRepo } from "../git/index.js";
import { withSpinner } from "../spinner.js";
import { BIN_NAME } from "../identity.js";

const HELP = `${BIN_NAME} explain — ask the active LLM provider to diagnose the most recent
${BIN_NAME} ship/commit failure (read-only, never executes anything).

Usage:
  ${BIN_NAME} explain                  # diagnose the last logged failure
  ${BIN_NAME} explain "<question>"     # ad-hoc question with current git state
  ${BIN_NAME} explain --show           # print the raw error log, do not call the LLM
  ${BIN_NAME} explain --clear          # delete the error log

Where the log lives:
  <repo>/.git/chi-last-error.log   (one per repo)

Uses the cura LLM endpoint (BASIC_AUTH_USER / BASIC_AUTH_PASSWORD required).
Run '${BIN_NAME} doctor cura' to verify the endpoint is reachable.
`;

type Mode = "explain" | "show" | "clear";

export async function run(argv: string[]): Promise<number> {
  let mode: Mode = "explain";
  let question = "";

  for (const a of argv) {
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--show") {
      mode = "show";
    } else if (a === "--clear") {
      mode = "clear";
    } else if (a.startsWith("-")) {
      process.stderr.write(`${BIN_NAME} explain: unknown option '${a}'\n`);
      return 1;
    } else {
      if (question) {
        process.stderr.write(`${BIN_NAME} explain: only one free-form question accepted\n`);
        return 1;
      }
      question = a;
    }
  }

  if (!isInsideRepo()) {
    process.stderr.write(`${BIN_NAME} explain: not a git repository\n`);
    return 1;
  }
  const dir = gitDir();
  if (!dir) return 1;
  const log = join(dir, "chi-last-error.log");

  if (mode === "clear") {
    if (existsSync(log)) {
      try {
        rmSync(log, { force: true });
        process.stdout.write(`${BIN_NAME} explain: cleared ${log}\n`);
      } catch (err) {
        process.stderr.write(`${BIN_NAME} explain: failed to clear ${log}: ${String(err)}\n`);
        return 1;
      }
    } else {
      process.stdout.write(`${BIN_NAME} explain: no error log to clear\n`);
    }
    return 0;
  }

  if (mode === "show") {
    if (!existsSync(log)) {
      process.stderr.write(`${BIN_NAME} explain: no error log at ${log}\n`);
      return 1;
    }
    process.stdout.write(readFileSync(log, "utf8"));
    return 0;
  }

  let context = "";
  if (existsSync(log)) {
    context = readFileSync(log, "utf8");
  } else {
    if (!question) {
      process.stderr.write(
        `${BIN_NAME} explain: no error log at ${log}\n\n` +
          `There has been no failed ${BIN_NAME} ship/commit recorded in this repo. Either:\n` +
          `  - run '${BIN_NAME} ship' / '${BIN_NAME} commit --push' until something fails, or\n` +
          `  - pass a free-form question:  ${BIN_NAME} explain "why is git push hanging?"\n`,
      );
      return 1;
    }
    const status = git(["status", "-sb"]).stdout;
    const histLog = git(["log", "-5", "--oneline"]).stdout;
    const remote = git(["remote", "-v"]).stdout;
    context =
      "(no recorded failure — live git state)\n\n" +
      "--- git status -sb ---\n" +
      status +
      "\n--- git log -5 --oneline ---\n" +
      histLog +
      "\n--- git remote -v ---\n" +
      remote;
  }

  const max = Number.parseInt(process.env.CHI_EXPLAIN_MAX_CHARS ?? "6000", 10) || 6000;
  if (context.length > max) {
    context = `${context.slice(0, max)}\n\n[context truncated at ${max} chars]`;
  }

  const userQ = question ? `User question: ${question}\n\n` : "";
  const prompt =
    "You are diagnosing a failed git or gh command for a developer.\n\n" +
    "Reply with EXACTLY this format and nothing else:\n\n" +
    "DIAGNOSIS: <one short sentence — what went wrong, in plain English>\n" +
    'COMMAND: <a single safe shell command they can run next, or "(none — manual investigation)">\n' +
    "WHY: <one short sentence — why that command should help>\n\n" +
    "Rules:\n" +
    "- Be specific to the captured output below; do NOT give generic git tips.\n" +
    "- The COMMAND must be a single line, copy-pasteable, and non-destructive\n" +
    "  unless the situation truly requires it. Prefer 'git status', 'git log',\n" +
    "  'git pull --rebase', 'git fetch' over force-push or reset --hard.\n" +
    "- If the situation needs human judgment (e.g. unresolved merge conflicts,\n" +
    '  ambiguous remote state), say so and put "(none — manual investigation)"\n' +
    "  in COMMAND.\n" +
    "- Do NOT suggest 'rm -rf', 'git push --force', 'git reset --hard' unless\n" +
    "  the captured output explicitly indicates the user already wants that.\n\n" +
    `${userQ}Captured context:\n${context}`;

  await providerEnsureRunning().catch(() => false);
  const provider = getProvider();
  if (!(await provider.ping())) {
    process.stderr.write(
      `${BIN_NAME} explain: provider '${activeProviderName()}' not reachable\n` +
        `             run '${BIN_NAME} doctor provider' for diagnostics\n`,
    );
    return 1;
  }

  let answer = "";
  try {
    answer = await withSpinner(
      `diagnosing via ${activeProviderName()} (${provider.activeModel()})`,
      () => provider.generate(prompt),
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`${BIN_NAME} explain: provider '${activeProviderName()}' request failed\n`);
    return 1;
  }

  if (!answer.trim()) {
    process.stderr.write(`${BIN_NAME} explain: provider returned empty response\n`);
    return 1;
  }

  process.stdout.write(`\n${answer}\n\n`);
  process.stderr.write("note: this suggestion was NOT executed. Copy + paste if it looks right.\n");
  return 0;
}
