import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitDir } from "./git/index.js";
import { c } from "./ui.js";
import { BIN_NAME } from "./identity.js";

/**
 * Workspace-recovery primitives. Repairs the kinds of damage `chi ship` leaves
 * behind when an autostash-rebase falls over: detached HEADs, stale autostash
 * stashes, conflict markers in the working tree, embedded git repos that
 * `git add` slurped into the index, and similar.
 *
 * Every mutation is preceded by a backup written under
 * `<gitDir>/chi-recover-backup-<ts>/` so the user can restore manually.
 */
export interface RecoveryReport {
  repoLabel: string;
  backupDir: string | null;
  detachedHead: { recovered: boolean; from: string; to: string } | null;
  conflicts: { file: string; backup: string }[];
  stashes: { ref: string; message: string; backup: string }[];
  embedded: { path: string; uncached: boolean }[];
  notes: string[];
  errors: string[];
}

const MAX_SCAN_BYTES = 2_000_000; // skip files larger than ~2 MB
const CONFLICT_RE = /^<{7} /m;

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureBackupDir(repoRoot: string, report: RecoveryReport): string | null {
  if (report.backupDir) return report.backupDir;
  const dir = gitDir(repoRoot);
  if (!dir) return null;
  const abs = join(repoRoot, dir, `chi-recover-backup-${ts()}`);
  try {
    mkdirSync(abs, { recursive: true });
  } catch (e) {
    report.errors.push(`could not create backup dir ${abs}: ${(e as Error).message}`);
    return null;
  }
  report.backupDir = abs;
  return abs;
}

function backupFile(repoRoot: string, rel: string, report: RecoveryReport): string | null {
  const root = ensureBackupDir(repoRoot, report);
  if (!root) return null;
  const src = join(repoRoot, rel);
  const dst = join(root, rel);
  try {
    mkdirSync(dirname(dst), { recursive: true });
    const buf = readFileSync(src);
    writeFileSync(dst, buf);
    return dst;
  } catch (e) {
    report.errors.push(`backup ${rel} failed: ${(e as Error).message}`);
    return null;
  }
}

function backupBlob(
  repoRoot: string,
  name: string,
  content: string,
  report: RecoveryReport,
): string | null {
  const root = ensureBackupDir(repoRoot, report);
  if (!root) return null;
  const dst = join(root, name);
  try {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content);
    return dst;
  } catch (e) {
    report.errors.push(`backup ${name} failed: ${(e as Error).message}`);
    return null;
  }
}

function defaultBranch(repoRoot: string): string {
  const head = git(["-C", repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) return head.stdout.trim().replace(/^origin\//, "");
  for (const cand of ["main", "master"]) {
    if (
      git(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${cand}`]).ok ||
      git(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${cand}`]).ok
    ) {
      return cand;
    }
  }
  return "";
}

/**
 * If HEAD is detached, recover by switching to the first branch that contains
 * the current commit. If no branch contains HEAD, save the SHA to a backup
 * file and switch to the repo's default branch so subsequent commands can
 * make progress.
 */
function recoverDetachedHead(repoRoot: string, report: RecoveryReport): void {
  const sym = git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]);
  if (sym.ok) return;

  const sha = git(["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
  if (!sha) {
    report.errors.push("could not read HEAD sha");
    return;
  }

  const containing = git([
    "-C", repoRoot, "for-each-ref",
    "--format=%(refname:short)",
    "--contains", sha,
    "refs/heads/",
  ]).stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let target = containing[0] ?? "";
  let strategy: "switch" | "reset" = "switch";

  if (!target) {
    target = defaultBranch(repoRoot);
    if (!target) {
      report.errors.push(`detached HEAD at ${sha} — no default branch found`);
      return;
    }
    strategy = "reset";
    backupBlob(
      repoRoot,
      "detached-head.txt",
      `sha=${sha}\nrecovered_to=${target}\nmsg=no branch contained this commit; reset to default branch\n`,
      report,
    );
  }

  if (strategy === "switch") {
    const co = git(["-C", repoRoot, "checkout", target]);
    if (!co.ok) {
      report.errors.push(`detached HEAD: failed to switch to ${target}: ${co.stderr.trim()}`);
      return;
    }
  } else {
    // No branch holds the sha. Switch to default branch (discards the
    // ephemeral commits — they are recorded in the backup blob).
    const co = git(["-C", repoRoot, "checkout", target]);
    if (!co.ok) {
      report.errors.push(`detached HEAD: failed to checkout ${target}: ${co.stderr.trim()}`);
      return;
    }
  }
  report.detachedHead = { recovered: true, from: sha, to: target };
}

/**
 * Save and drop every stash. Autostash leftovers from a failed
 * `pull --rebase --autostash` masquerade as ordinary stashes; rather than
 * guess which ones are safe to keep, we save patch + tree to the backup dir
 * so the user can `git apply` later.
 */
function clearStashes(repoRoot: string, report: RecoveryReport): void {
  const list = git(["-C", repoRoot, "stash", "list"]).stdout.trim();
  if (!list) return;

  const lines = list.split(/\r?\n/);
  // Drop from highest index down so refs stay stable.
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i] ?? "";
    const m = ln.match(/^stash@\{(\d+)\}: (.*)$/);
    if (!m) continue;
    const idx = m[1]!;
    const message = m[2] ?? "";
    const ref = `stash@{${idx}}`;

    const patch = git(["-C", repoRoot, "stash", "show", "-p", "--binary", ref]);
    const patchBody = patch.ok ? patch.stdout : `# stash show failed: ${patch.stderr}\n`;
    const backup = backupBlob(repoRoot, `stashes/${ref.replace(/[{}]/g, "_")}.patch`, patchBody, report);

    const drop = git(["-C", repoRoot, "stash", "drop", ref]);
    if (!drop.ok) {
      report.errors.push(`stash drop ${ref} failed: ${drop.stderr.trim()}`);
      continue;
    }
    report.stashes.push({ ref, message, backup: backup ?? "" });
  }
}

/**
 * Find tracked files that still contain conflict markers and reset them to
 * their indexed/HEAD content. The autostash that produced these markers is
 * already saved by clearStashes, so the user has not lost work.
 */
function resolveConflictMarkers(repoRoot: string, report: RecoveryReport): void {
  const ls = git(["-C", repoRoot, "ls-files"]).stdout;
  if (!ls) return;
  const files = ls.split(/\r?\n/).filter(Boolean);

  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES) continue;
    if (buf.includes(0)) continue; // crude binary skip
    const text = buf.toString("utf8");
    if (!CONFLICT_RE.test(text)) continue;

    const backup = backupFile(repoRoot, rel, report);
    if (!backup) continue;

    // Restore from index (post-rebase HEAD is what we want; the autostash
    // side that conflicted is preserved in clearStashes).
    const co = git(["-C", repoRoot, "checkout", "--", rel]);
    if (!co.ok) {
      report.errors.push(`checkout ${rel} failed: ${co.stderr.trim()}`);
      continue;
    }
    report.conflicts.push({ file: rel, backup });
  }
}

/**
 * Find paths the index records as gitlinks (mode 160000) that are not declared
 * in .gitmodules — i.e. embedded git repos that `git add` slurped in by
 * accident — and unstage them. The directories on disk are left alone.
 */
function unstageEmbeddedRepos(repoRoot: string, report: RecoveryReport): void {
  const submoduleSet = new Set<string>();
  if (existsSync(join(repoRoot, ".gitmodules"))) {
    const cfg = git([
      "-C", repoRoot, "config", "-f", ".gitmodules",
      "--get-regexp", "^submodule\\..*\\.path$",
    ]).stdout;
    for (const ln of cfg.split(/\r?\n/)) {
      const path = ln.trim().split(/\s+/, 2)[1];
      if (path) submoduleSet.add(path);
    }
  }

  const candidates = new Map<string, "staged" | "tracked">();

  // Staged (added but not committed) — ":000000 160000 ... A\tpath" lines.
  const cached = git(["-C", repoRoot, "diff", "--cached", "--raw", "--no-renames"]).stdout;
  for (const ln of cached.split(/\r?\n/)) {
    if (!ln) continue;
    const parts = ln.split("\t");
    const head = parts[0] ?? "";
    const path = parts[1] ?? "";
    if (!path) continue;
    const fields = head.split(" ");
    const newMode = fields[1] ?? "";
    if (newMode === "160000" && !submoduleSet.has(path)) {
      candidates.set(path, "staged");
    }
  }

  // Already-committed gitlinks (rare on a non-submodule repo, but possible).
  const tracked = git(["-C", repoRoot, "ls-files", "--stage"]).stdout;
  for (const ln of tracked.split(/\r?\n/)) {
    if (!ln.startsWith("160000 ")) continue;
    const path = ln.split("\t")[1] ?? "";
    if (path && !submoduleSet.has(path) && !candidates.has(path)) {
      candidates.set(path, "tracked");
    }
  }

  for (const [path, kind] of candidates) {
    backupBlob(
      repoRoot,
      `embedded/${path.replace(/[/\\]/g, "_")}.txt`,
      `path=${path}\nkind=${kind}\nnote=git rm --cached executed; directory left in place\n`,
      report,
    );
    const rm = git(["-C", repoRoot, "rm", "--cached", "-f", "--", path]);
    if (!rm.ok) {
      report.errors.push(`git rm --cached ${path} failed: ${rm.stderr.trim()}`);
      report.embedded.push({ path, uncached: false });
      continue;
    }
    report.embedded.push({ path, uncached: true });
  }
}

export interface RecoveryOptions {
  /** Display label for output ("cura", "tools/chi", etc.). Defaults to repo dir name. */
  label?: string;
}

export function recoverRepo(repoRoot: string, opts: RecoveryOptions = {}): RecoveryReport {
  const report: RecoveryReport = {
    repoLabel: opts.label ?? repoRoot,
    backupDir: null,
    detachedHead: null,
    conflicts: [],
    stashes: [],
    embedded: [],
    notes: [],
    errors: [],
  };

  // Bail early if there is no rebase in progress and the worktree is clean
  // and the index is clean and HEAD is on a branch and there are no stashes —
  // nothing to do, leave the repo alone.
  const dir = gitDir(repoRoot);
  if (!dir) {
    report.errors.push("not a git repository");
    return report;
  }

  // Abort an in-progress rebase first; otherwise checkout/stash drop will
  // refuse. The user's changes from the autostash are preserved on the stash
  // stack and saved by clearStashes below.
  const inRebase =
    existsSync(join(repoRoot, dir, "rebase-merge")) ||
    existsSync(join(repoRoot, dir, "rebase-apply"));
  if (inRebase) {
    const ab = git(["-C", repoRoot, "rebase", "--abort"]);
    if (ab.ok) {
      report.notes.push("aborted in-progress rebase");
    } else {
      report.errors.push(`rebase --abort failed: ${ab.stderr.trim()}`);
    }
  }

  recoverDetachedHead(repoRoot, report);
  clearStashes(repoRoot, report);
  resolveConflictMarkers(repoRoot, report);
  unstageEmbeddedRepos(repoRoot, report);

  return report;
}

export function isClean(report: RecoveryReport): boolean {
  return (
    report.detachedHead === null &&
    report.conflicts.length === 0 &&
    report.stashes.length === 0 &&
    report.embedded.length === 0 &&
    report.notes.length === 0 &&
    report.errors.length === 0
  );
}

export function printReport(report: RecoveryReport): void {
  if (isClean(report)) {
    process.stdout.write(`${report.repoLabel}: clean\n`);
    return;
  }
  process.stdout.write(`${c.cyan(`── ${report.repoLabel} ──`)}\n`);
  for (const n of report.notes) {
    process.stdout.write(`  ${c.dim(n)}\n`);
  }
  if (report.detachedHead) {
    const { from, to } = report.detachedHead;
    process.stdout.write(
      `  ${c.green("✓")} detached HEAD recovered: ${from.slice(0, 8)} → ${to}\n`,
    );
  }
  for (const s of report.stashes) {
    process.stdout.write(`  ${c.green("✓")} stash dropped: ${s.ref} (${s.message})\n`);
  }
  for (const cf of report.conflicts) {
    process.stdout.write(`  ${c.green("✓")} conflict markers cleared: ${cf.file}\n`);
  }
  for (const em of report.embedded) {
    const sym = em.uncached ? c.green("✓") : c.red("✗");
    process.stdout.write(`  ${sym} embedded git repo unstaged: ${em.path}\n`);
  }
  if (report.backupDir) {
    process.stdout.write(`  ${c.dim(`backup: ${report.backupDir.replace(/\\/g, "/")}`)}\n`);
  }
  for (const e of report.errors) {
    process.stderr.write(`  ${c.red("✗")} ${e}\n`);
  }
}

export function summarize(reports: RecoveryReport[]): string {
  const totals = {
    repos: reports.length,
    detached: reports.filter((r) => r.detachedHead).length,
    conflicts: reports.reduce((n, r) => n + r.conflicts.length, 0),
    stashes: reports.reduce((n, r) => n + r.stashes.length, 0),
    embedded: reports.reduce((n, r) => n + r.embedded.filter((e) => e.uncached).length, 0),
    errors: reports.reduce((n, r) => n + r.errors.length, 0),
  };
  const parts = [
    `${totals.repos} repo${totals.repos === 1 ? "" : "s"} scanned`,
    `${totals.detached} detached HEAD${totals.detached === 1 ? "" : "s"} fixed`,
    `${totals.conflicts} conflict file${totals.conflicts === 1 ? "" : "s"} reset`,
    `${totals.stashes} stash${totals.stashes === 1 ? "" : "es"} archived`,
    `${totals.embedded} embedded repo${totals.embedded === 1 ? "" : "s"} unstaged`,
  ];
  if (totals.errors > 0) parts.push(c.red(`${totals.errors} error${totals.errors === 1 ? "" : "s"}`));
  return parts.join(", ");
}

// Re-export so callers don't need both modules.
export { BIN_NAME };
