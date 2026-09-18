import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git/index.js";
import { execSync, execAsync, commandExists } from "./spawn.js";
import { singleKeyMenu } from "./menu.js";
import { c } from "./ui.js";
import { BIN_NAME } from "./identity.js";

export interface ResolveResult {
  resolved: number;
  skipped: number;
  aborted: boolean;
}

const MENU_KEYS = ["a", "o", "t", "e", "r", "s", "q"];
const MENU_PROMPT = `  ${c.bold("[a]")}ccept  ${c.bold("[o]")}urs  ${c.bold("[t]")}heirs  ${c.bold("[e]")}dit  ${c.bold("[r]")}etry+hint  ${c.bold("[s]")}kip  ${c.bold("[q]")}uit\n  > `;

const CLAUDE_TIMEOUT_MS = 60_000;
const MAX_FILE_SIZE = 200_000; // skip files larger than ~200KB
const MAX_HUNKS = 25; // fall back to whole-file mode above this
const CONTEXT_LINES = 8; // lines of surrounding context sent with each hunk

/**
 * Attempt AI-assisted conflict resolution for all conflicted files in an
 * active rebase. Called from `chi ship` when rebase produces conflicts.
 *
 * Returns immediately (no-op) when:
 * - CHI_RESOLVE_CONFLICTS=0
 * - stdin is not a TTY
 * - `claude` is not on PATH
 */
export async function resolveConflicts(repoRoot: string): Promise<ResolveResult> {
  const bail: ResolveResult = { resolved: 0, skipped: 0, aborted: true };

  // Opt-out gate
  if (process.env.CHI_RESOLVE_CONFLICTS === "0") return bail;

  // TTY required for interactive menu
  if (!process.stdin.isTTY) {
    process.stderr.write(c.dim(`${BIN_NAME} ship: non-interactive terminal — skipping conflict resolver\n`));
    return bail;
  }

  // claude must be available
  if (!commandExists("claude")) {
    process.stderr.write(
      c.yellow(`${BIN_NAME} ship: 'claude' not found on PATH — cannot auto-resolve conflicts\n`),
    );
    return bail;
  }

  const conflictOutput = git(["-C", repoRoot, "diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  if (!conflictOutput) return { resolved: 0, skipped: 0, aborted: false };

  const files = conflictOutput.split(/\r?\n/).filter(Boolean);
  process.stderr.write(
    `\n${c.bold(`${BIN_NAME} ship: conflict resolver`)} — ${files.length} file(s)\n\n`,
  );

  // Get incoming commit context for the prompt
  const commitLog = git(["-C", repoRoot, "log", "--oneline", "-5", "REBASE_HEAD"]).stdout.trim();

  let resolved = 0;
  let skipped = 0;

  for (const relPath of files) {
    const absPath = join(repoRoot, relPath);
    process.stderr.write(`${c.cyan(relPath)}\n`);

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      process.stderr.write(c.dim("  (cannot read file — skipping)\n"));
      skipped++;
      continue;
    }

    if (content.length > MAX_FILE_SIZE) {
      process.stderr.write(c.dim("  (file too large for AI resolution — skipping)\n"));
      skipped++;
      continue;
    }

    // Initial AI resolution attempt
    let proposal = await invokeClaudeResolve(content, commitLog, relPath);
    if (proposal === null) {
      process.stderr.write(c.dim("  (claude returned no resolution — skipping)\n"));
      skipped++;
      continue;
    }

    // Show diff between conflicted file and proposal
    showProposalDiff(content, proposal, relPath);

    // Menu loop (retry+hint can loop)
    let done = false;
    while (!done) {
      const choice = await singleKeyMenu(MENU_PROMPT, MENU_KEYS);

      switch (choice) {
        case "a": // accept
          writeFileSync(absPath, proposal);
          git(["-C", repoRoot, "add", relPath]);
          resolved++;
          done = true;
          break;

        case "o": // ours
          git(["-C", repoRoot, "checkout", "--ours", "--", relPath]);
          git(["-C", repoRoot, "add", relPath]);
          resolved++;
          done = true;
          break;

        case "t": // theirs
          git(["-C", repoRoot, "checkout", "--theirs", "--", relPath]);
          git(["-C", repoRoot, "add", relPath]);
          resolved++;
          done = true;
          break;

        case "e": { // edit
          const editor = process.env.EDITOR || process.env.VISUAL || "vi";
          const editorArgs = editor.split(/\s+/);
          const editorBin = editorArgs.shift()!;
          await execAsync(editorBin, [...editorArgs, absPath], { inherit: true });
          git(["-C", repoRoot, "add", relPath]);
          resolved++;
          done = true;
          break;
        }

        case "r": { // retry with hint
          process.stdout.write("  hint: ");
          const hint = await readLine();
          const retried = await invokeClaudeResolve(content, commitLog, relPath, hint);
          if (retried === null) {
            process.stderr.write(c.dim("  (claude returned no resolution)\n"));
          } else {
            proposal = retried;
            showProposalDiff(content, proposal, relPath);
          }
          // Loop back to menu
          break;
        }

        case "s": // skip
          skipped++;
          done = true;
          break;

        case "q": // quit
          return { resolved, skipped: skipped + (files.length - resolved - skipped), aborted: true };

        default:
          done = true;
          skipped++;
      }
    }
  }

  const aborted = skipped > 0;
  return { resolved, skipped, aborted };
}

/**
 * After resolveConflicts returns, the caller should:
 * - If !aborted && skipped === 0 → git rebase --continue
 * - If aborted → git rebase --abort
 */
export function finalizeRebase(repoRoot: string, result: ResolveResult): number {
  if (result.aborted || result.skipped > 0) {
    git(["-C", repoRoot, "rebase", "--abort"]);
    if (result.resolved > 0) {
      process.stderr.write(
        c.yellow(
          `chi ship: ${result.resolved} file(s) resolved, ${result.skipped} skipped — rebase aborted\n`,
        ),
      );
    } else {
      process.stderr.write(c.red(`${BIN_NAME} ship: conflict resolution aborted — rebase aborted\n`));
    }
    return 1;
  }

  // All files resolved — continue rebase
  const cont = git(["-C", repoRoot, "rebase", "--continue"]);
  if (!cont.ok) {
    process.stderr.write(cont.stderr);
    process.stderr.write(c.red(`${BIN_NAME} ship: rebase --continue failed after resolution\n`));
    git(["-C", repoRoot, "rebase", "--abort"]);
    return 1;
  }

  process.stderr.write(c.green(`chi ship: all ${result.resolved} conflict(s) resolved, rebase complete\n`));
  return 0;
}

// --- internals ---

interface TextSegment {
  kind: "text";
  lines: string[];
}

interface ConflictSegment {
  kind: "conflict";
  oursLabel: string;
  ours: string[];
  base: string[] | null;
  theirsLabel: string;
  theirs: string[];
}

type Segment = TextSegment | ConflictSegment;

/**
 * Split a conflicted file into alternating text and conflict-hunk segments
 * by walking its <<<<<<</=======/>>>>>>> (and optional |||||||) markers.
 * Returns null if the markers are malformed/nested — caller falls back to
 * whole-file resolution in that case.
 */
function parseConflictSegments(content: string): Segment[] | null {
  const lines = content.split("\n");
  const segments: Segment[] = [];

  let mode: "text" | "ours" | "base" | "theirs" = "text";
  let textBuf: string[] = [];
  let oursBuf: string[] = [];
  let baseBuf: string[] = [];
  let theirsBuf: string[] = [];
  let oursLabel = "";
  let theirsLabel = "";
  let hasBase = false;

  for (const line of lines) {
    if (mode === "text" && line.startsWith("<<<<<<< ")) {
      segments.push({ kind: "text", lines: textBuf });
      textBuf = [];
      oursBuf = [];
      baseBuf = [];
      theirsBuf = [];
      hasBase = false;
      oursLabel = line.slice("<<<<<<< ".length);
      mode = "ours";
    } else if (mode === "ours" && line.startsWith("||||||| ")) {
      hasBase = true;
      mode = "base";
    } else if ((mode === "ours" || mode === "base") && line === "=======") {
      mode = "theirs";
    } else if (mode === "theirs" && line.startsWith(">>>>>>> ")) {
      theirsLabel = line.slice(">>>>>>> ".length);
      segments.push({
        kind: "conflict",
        oursLabel,
        ours: oursBuf,
        base: hasBase ? baseBuf : null,
        theirsLabel,
        theirs: theirsBuf,
      });
      textBuf = [];
      mode = "text";
    } else if (mode === "text") {
      textBuf.push(line);
    } else if (mode === "ours") {
      oursBuf.push(line);
    } else if (mode === "base") {
      baseBuf.push(line);
    } else {
      theirsBuf.push(line);
    }
  }

  if (mode !== "text") return null; // unterminated conflict marker — malformed
  segments.push({ kind: "text", lines: textBuf });

  const hunkCount = segments.filter((s) => s.kind === "conflict").length;
  if (hunkCount === 0) return null;
  return segments;
}

function contextBefore(segments: Segment[], conflictIndex: number): string[] {
  const prev = segments[conflictIndex - 1];
  if (!prev || prev.kind !== "text") return [];
  return prev.lines.slice(-CONTEXT_LINES);
}

function contextAfter(segments: Segment[], conflictIndex: number): string[] {
  const next = segments[conflictIndex + 1];
  if (!next || next.kind !== "text") return [];
  return next.lines.slice(0, CONTEXT_LINES);
}

async function invokeClaudeResolve(
  conflictedContent: string,
  commitLog: string,
  relPath: string,
  hint?: string,
): Promise<string | null> {
  const segments = parseConflictSegments(conflictedContent);
  const hunkCount = segments?.filter((s) => s.kind === "conflict").length ?? 0;

  if (!segments || hunkCount > MAX_HUNKS) {
    // Malformed markers or too many hunks to resolve individually — whole file.
    const prompt = buildWholeFilePrompt(conflictedContent, commitLog, relPath, hint);
    const result = execSync("claude", ["-p", prompt], { timeoutMs: CLAUDE_TIMEOUT_MS });
    if (!result.ok || !result.stdout.trim()) return null;
    const resolved = result.stdout.replace(/\n$/, "");
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(resolved)) return null;
    return resolved;
  }

  const outLines: string[] = [];
  let hunkNum = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "text") {
      outLines.push(...seg.lines);
      continue;
    }

    hunkNum++;
    if (hunkCount > 1) {
      process.stderr.write(c.dim(`  resolving hunk ${hunkNum}/${hunkCount}...\n`));
    }

    const prompt = buildHunkPrompt(
      seg,
      contextBefore(segments, i),
      contextAfter(segments, i),
      commitLog,
      relPath,
      hint,
    );
    const result = execSync("claude", ["-p", prompt], { timeoutMs: CLAUDE_TIMEOUT_MS });
    if (!result.ok || !result.stdout.trim()) return null;

    const resolved = result.stdout.replace(/\n$/, "");
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(resolved)) {
      // Claude echoed markers back instead of resolving — treat as failure.
      return null;
    }
    outLines.push(...resolved.split("\n"));
  }

  return outLines.join("\n");
}

function buildHunkPrompt(
  hunk: ConflictSegment,
  before: string[],
  after: string[],
  commitLog: string,
  relPath: string,
  hint?: string,
): string {
  let p =
    `You are resolving ONE git merge conflict hunk inside ${relPath}. ` +
    "Output ONLY the replacement code for this hunk — no conflict markers, no explanations, " +
    "no markdown fences, no commentary, and no surrounding context lines (those are shown only " +
    "for orientation and must not be repeated in your output). " +
    "Combine or pick between the two sides as appropriate; do not rewrite or invent code beyond " +
    "what is needed to resolve this specific hunk.\n\n";

  if (before.length) {
    p += "Context immediately before the hunk:\n" + before.join("\n") + "\n\n";
  }

  p += `Our side (${hunk.oursLabel}):\n${hunk.ours.join("\n")}\n\n`;
  if (hunk.base) {
    p += `Common ancestor:\n${hunk.base.join("\n")}\n\n`;
  }
  p += `Their side (${hunk.theirsLabel}):\n${hunk.theirs.join("\n")}\n\n`;

  if (after.length) {
    p += "Context immediately after the hunk:\n" + after.join("\n") + "\n\n";
  }

  p += "Recent commits being rebased:\n" + commitLog;
  if (hint) {
    p += `\n\nUser hint for resolution: ${hint}`;
  }
  return p;
}

function buildWholeFilePrompt(content: string, commitLog: string, relPath: string, hint?: string): string {
  let p =
    `You are resolving git merge conflicts in ${relPath}. Output ONLY the resolved file content — ` +
    "no explanations, no markdown fences, no commentary. Preserve every line outside the conflict " +
    "markers exactly as-is; only decide the content within each <<<<<<< / ======= / >>>>>>> block. " +
    "The file with conflict markers:\n\n" +
    content +
    "\n\nRecent commits being rebased:\n" +
    commitLog;
  if (hint) {
    p += `\n\nUser hint for resolution: ${hint}`;
  }
  return p;
}

function showProposalDiff(original: string, proposal: string, _relPath: string): void {
  const origLines = original.split("\n");
  const propLines = proposal.split("\n");

  process.stdout.write(c.dim("  --- proposed resolution ---\n"));

  // Simple inline diff: show lines that differ
  const maxLines = Math.max(origLines.length, propLines.length);
  let shown = 0;
  const contextWindow = 2;
  let lastShown = -contextWindow - 1;

  for (let i = 0; i < maxLines; i++) {
    const orig = origLines[i];
    const prop = propLines[i];
    if (orig !== prop) {
      // Show context before
      for (let j = Math.max(lastShown + 1, i - contextWindow); j < i; j++) {
        if (j >= 0 && j < propLines.length) {
          process.stdout.write(`  ${c.dim(`  ${propLines[j]}`)}\n`);
        }
      }
      if (orig !== undefined && orig !== prop) {
        process.stdout.write(`  ${c.red(`- ${orig}`)}\n`);
      }
      if (prop !== undefined) {
        process.stdout.write(`  ${c.green(`+ ${prop}`)}\n`);
      }
      lastShown = i;
      shown++;
      if (shown > 40) {
        process.stdout.write(c.dim(`  ... (${maxLines - i - 1} more lines)\n`));
        break;
      }
    }
  }
  process.stdout.write(c.dim("  ---\n"));
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isRaw) stdin.setRawMode(false);

    let buf = "";
    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf8");
      buf += str;
      if (buf.includes("\n")) {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(true);
        resolve(buf.trim());
      }
    };
    stdin.on("data", onData);
  });
}
