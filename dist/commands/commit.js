import { activeProviderName, getProvider, providerEnsureRunning, providerSmartGenerate, } from "../provider/index.js";
import { git, isInsideRepo, pushWithRecovery } from "../git/index.js";
import { withSpinner } from "../spinner.js";
import { readLine } from "../prompt.js";
import { execInherit } from "../spawn.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN_NAME } from "../identity.js";
import { c, sym } from "../ui.js";
const HELP = `${BIN_NAME} commit — stage all changes, generate a commit message via the active LLM, commit.

Usage: ${BIN_NAME} commit [options]

Options:
  -p, --push      push after commit
  -n, --dry-run   only print the generated message, do not commit
  -y, --yes       skip confirmation prompt
  -e, --edit      open editor to tweak the message before committing
  -h, --help      show this help

Environment (required):
  BASIC_AUTH_USER          basic-auth username for the cura endpoint
  BASIC_AUTH_PASSWORD      basic-auth password for the cura endpoint

Environment (optional):
  CHI_LLM_URL              override default cura URL
  CHI_LLM_MODEL            override default cura model (default: smollm2:135m)
  CHI_OLLAMA_URL           override default ollama URL (default: http://localhost:11434)
  CHI_OLLAMA_MODEL         pin a specific ollama model (skips auto-detection,
                           required when only embedding models are installed)
  CHI_MAX_DIFF_CHARS       diff truncation (default: 8000)
`;
function parseArgs(argv) {
    const opts = { push: false, dry: false, yes: false, edit: false };
    for (const arg of argv) {
        switch (arg) {
            case "-p":
            case "--push":
                opts.push = true;
                break;
            case "-n":
            case "--dry-run":
                opts.dry = true;
                break;
            case "-y":
            case "--yes":
                opts.yes = true;
                break;
            case "-e":
            case "--edit":
                opts.edit = true;
                break;
            case "-h":
            case "--help":
                return { help: true };
            default:
                return { error: `${BIN_NAME} commit: unknown option '${arg}'` };
        }
    }
    return opts;
}
function buildPrompt(diff) {
    return [
        "You are generating a git commit message from a diff.",
        "",
        "Format:",
        "<title>",
        "<blank line>",
        "- <important point>",
        "- <important point>",
        "- <important point>",
        "",
        "Rules:",
        "- Reply with ONLY the commit message. No quotes, no explanation, no preamble.",
        "- Output PLAIN TEXT only. No markdown formatting of any kind: no headers (#, ##), no bold (**X**), no italics, no code fences (```), no nested lists.",
        '- Title: one line, at least 4 words and max 72 characters, imperative mood starting with a verb (e.g. "add", "fix", "refactor"). Never a single word. The title must NOT be wrapped in ** or any other markup.',
        '- Body: 2-5 bullets, each starting with "- " (dash space, never "* "), describing the important changes.',
        "- Each bullet should be concise (max ~100 characters) and focus on what changed and why.",
        "- Skip the body only if the change is trivial (e.g. typo fix, single-line tweak).",
        "- If multiple unrelated changes, the title summarizes the dominant one; bullets cover the rest.",
        '- Never narrate yourself or the task. Forbidden openings: "I will", "I\'ll", "I\'ve", "Here is", "Here\'s", "Below is", "Sure", "Okay", "Let me", "Let\'s", "This", "That", "These", "Those", "The diff", "The changes", "The code", "The provided", "The following".',
        '- Do not reference the prompt input. Forbidden phrases: "the diff", "the provided code", "the code example", "the attached", "the following code", "the original code".',
        "- Never echo source code lines from the diff as the title or body. Describe the change, do not paste it.",
        "",
        "Diff:",
        diff,
    ].join("\n");
}
const META_TITLE_RE = /^\s*(i\b|i'?ll\b|i'?m\b|i'?ve\b|we\b|here\b|here'?s\b|below\b|sure\b|okay\b|ok\b|let\b|let'?s\b|this\b|that\b|these\b|those\b|first\b|now\b|alright\b|response\b|summary\b|in\s+summary\b|to\s+summarize\b|the\s+(diff|change|changes|code|provided|following|patch|file|files|original)\b)/i;
const ECHOED_CODE_RE = /^\s*(import\s|export\s|class\s+\w|function\s+\w|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+\w|public\s|private\s|return\s|if\s*\(|<\w)/;
const META_REFERENCE_RE = /\b(provided\s+code|code\s+example|the\s+diff|the\s+code|attached|the\s+following\s+code|original\s+code)\b/i;
function looksLikeMeta(title) {
    if (!title)
        return false;
    if (META_TITLE_RE.test(title))
        return true;
    if (ECHOED_CODE_RE.test(title))
        return true;
    if (META_REFERENCE_RE.test(title))
        return true;
    return false;
}
/** Light cleanup of small-model output: strip code fences, ATX headers, **bold**,
 *  '* ' bullets normalized to '- ', drop leading blank lines and trailing blank
 *  lines. Then enforce blank line between subject and body. */
function cleanupMessage(raw) {
    const stripped = raw
        .split(/\r?\n/)
        .filter((ln) => !/^\s*```/.test(ln))
        .map((ln) => {
        let out = ln.replace(/^\s*#+\s+/, "");
        out = out.replace(/\*\*/g, "");
        out = out.replace(/^\*\s+/, "- ");
        return out;
    });
    // drop leading blank lines
    while (stripped.length > 0 && stripped[0].trim() === "")
        stripped.shift();
    // drop trailing blank lines
    while (stripped.length > 0 && stripped[stripped.length - 1].trim() === "")
        stripped.pop();
    if (stripped.length === 0)
        return "";
    // strip leading whitespace + matched surrounding quotes from title
    stripped[0] = (stripped[0] ?? "").replace(/^\s+/, "").replace(/^["']|["']$/g, "");
    // reject meta-responses ("I will...", "Here is...", echoed source code) so
    // the caller falls back to fallbackMessage().
    if (looksLikeMeta(stripped[0] ?? ""))
        return "";
    // enforce blank line between subject and body
    if (stripped.length > 1 && stripped[1].trim() !== "") {
        stripped.splice(1, 0, "");
    }
    return stripped.join("\n");
}
function fallbackMessage() {
    const files = git(["diff", "--cached", "--name-only"]).stdout
        .split(/\r?\n/)
        .filter((s) => s.length > 0);
    const head = files.length === 1 ? `update ${files[0]}` : `update ${files.length} files`;
    return [head, "", ...files.map((f) => `- ${f}`)].join("\n");
}
export async function run(argv) {
    const parsed = parseArgs(argv);
    if ("help" in parsed) {
        process.stdout.write(HELP);
        return 0;
    }
    if ("error" in parsed) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
    }
    const opts = parsed;
    if (!isInsideRepo()) {
        process.stderr.write(`${BIN_NAME} commit: not a git repository\n`);
        return 1;
    }
    const add = git(["add", "-A"]);
    if (!add.ok) {
        process.stderr.write(add.stderr);
        return add.status ?? 1;
    }
    if (add.stderr)
        process.stderr.write(add.stderr);
    const diffRes = git(["diff", "--cached", "--no-color"]);
    let diff = diffRes.stdout;
    if (!diff) {
        process.stderr.write(`${BIN_NAME} commit: nothing staged, nothing to commit\n`);
        return 0;
    }
    const max = Number.parseInt(process.env.CHI_MAX_DIFF_CHARS ?? "8000", 10) || 8000;
    if (diff.length > max) {
        diff = `${diff.slice(0, max)}\n\n[diff truncated at ${max} chars]`;
    }
    const prompt = buildPrompt(diff);
    await providerEnsureRunning().catch(() => false);
    const provider = getProvider();
    let msg = "";
    let raw = "";
    try {
        raw = await withSpinner(`thinking via ${activeProviderName()} (${provider.activeModel()})`, () => providerSmartGenerate(prompt));
        msg = cleanupMessage(raw);
        if (!msg && raw.trim()) {
            // Raw response existed but was rejected by cleanupMessage (typically
            // because looksLikeMeta caught a "Here is..." preamble). Retry once
            // with a sharpened reminder.
            const retryPrompt = prompt +
                '\n\nReminder: respond with ONLY the commit message. The previous attempt was rejected because it started with meta narration like "Here is" or "The diff". Begin directly with a verb in the imperative mood.';
            raw = await withSpinner(`retrying via ${activeProviderName()} (${provider.activeModel()})`, () => providerSmartGenerate(retryPrompt));
            msg = cleanupMessage(raw);
        }
        if (!msg) {
            const reason = raw.trim()
                ? `rejected as meta/echoed-code (first line: ${JSON.stringify(raw.split(/\r?\n/)[0]?.slice(0, 80) ?? "")})`
                : "raw response was empty";
            process.stderr.write(`${sym.warn} ${c.dim(`${BIN_NAME} commit:`)} ${c.yellow("LLM returned no usable message")} ${c.dim(`— ${reason} — using default message`)}\n`);
        }
    }
    catch (err) {
        process.stderr.write(`${sym.err} ${c.red(err instanceof Error ? err.message : String(err))}\n`);
        process.stderr.write(`${sym.warn} ${c.dim(`${BIN_NAME} commit:`)} ${c.yellow("message generation failed")} ${c.dim("— using default message")}\n` +
            `             ${c.dim(`run '${BIN_NAME} doctor provider' for diagnostics`)}\n`);
    }
    if (!msg)
        msg = fallbackMessage();
    const lines = msg.split(/\r?\n/);
    const title = lines[0] ?? "";
    const body = lines.slice(1).join("\n").replace(/^\n+/, "");
    process.stdout.write(`\n${sym.arrow} ${c.bold(title)}\n`);
    if (body.trim()) {
        for (const ln of body.split(/\r?\n/)) {
            process.stdout.write(`  ${c.dim(ln)}\n`);
        }
    }
    process.stdout.write("\n");
    if (opts.dry)
        return 0;
    let edit = opts.edit;
    if (!opts.yes && !edit) {
        const ans = await readLine("commit with this message? [Y/n/e=edit] ");
        const v = (ans ?? "").trim().toLowerCase();
        if (v === "n" || v === "no") {
            process.stdout.write(`${c.yellow("aborted")}\n`);
            return 1;
        }
        if (v === "e")
            edit = true;
    }
    const tmp = mkdtempSync(join(tmpdir(), "chi-commit-"));
    const msgFile = join(tmp, "COMMIT_EDITMSG");
    try {
        writeFileSync(msgFile, `${msg}\n`);
        const args = edit ? ["commit", "-e", "-F", msgFile] : ["commit", "-F", msgFile];
        const code = await execInherit("git", args);
        if (code !== 0)
            return code;
    }
    finally {
        try {
            rmSync(tmp, { recursive: true, force: true });
        }
        catch {
            /* ignore */
        }
    }
    if (opts.push) {
        return await pushWithRecovery();
    }
    return 0;
}
//# sourceMappingURL=commit.js.map