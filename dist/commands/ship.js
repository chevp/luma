import { basename, dirname, join } from "node:path";
import { existsSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { commandExists, execInherit, execSync } from "../spawn.js";
import { git, gitDir, isInsideRepo, pushWithRecovery } from "../git/index.js";
import { resolveConflicts, finalizeRebase } from "../conflict.js";
import { c, sym } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { readMarker } from "./flow.js";
import { run as commitRun } from "./commit.js";
import { listActiveChiFlows } from "./work.js";
import { maybePrintUpdateNotice } from "../version-check.js";
import { DRY_ENV, isDry, dryNote } from "../dry.js";
import { maybeBumpVersions } from "../version-bump.js";
import { globalShip } from "./ship-workspace.js";
const HELP = `${BIN_NAME} ship — for this repo and every submodule (recursively):
  init if missing, fast-forward pull if on a branch, then add + commit + push.

In flow mode (.git/chi-flow present): commit, push -u origin <branch>, and on
first call open a draft PR via gh.

Workspace-root mode (cwd is not a git repo):
  Discover repos one or two levels deep, optionally clone any missing repos
  via misc/chevp-setup/clone-all.py, then run \`${BIN_NAME} ship\` in each.

Options:
  --dry, --dry-run   training mode: print what would happen, write nothing.
                     Propagates into submodules and workspace fan-out.
`;
const SELF_BIN = process.argv[1] ?? "chi";
/**
 * Parse `git pull/checkout/merge` stderr for the
 * "untracked working tree files would be overwritten" diagnostic and return
 * the relative paths git listed. Empty array if the pattern is absent.
 */
function parseOverwrittenUntracked(stderr) {
    const m = stderr.match(/untracked working tree files would be overwritten[^\n:]*:\r?\n([\s\S]*?)(?:\r?\n(?:Aborting|Please move or remove them))/i);
    if (!m || !m[1])
        return [];
    const out = [];
    for (const ln of m[1].split(/\r?\n/)) {
        const trimmed = ln.trim();
        if (!trimmed)
            continue;
        out.push(trimmed);
    }
    return out;
}
/**
 * Move untracked paths blocking a pull into .git/chi-overwrite-backup-<ts>/,
 * preserving relative paths so the user can recover them later. Returns the
 * backup directory and per-file outcomes. Files that fail to move are
 * reported back so the caller can abort cleanly.
 */
function backupBlockingFiles(repoRoot, paths) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(repoRoot, ".git", `chi-overwrite-backup-${ts}`);
    mkdirSync(backupDir, { recursive: true });
    let moved = 0;
    const failed = [];
    for (const rel of paths) {
        const src = join(repoRoot, rel);
        const dst = join(backupDir, rel);
        try {
            mkdirSync(dirname(dst), { recursive: true });
            renameSync(src, dst);
            moved++;
        }
        catch {
            failed.push(rel);
        }
    }
    return { backupDir, moved, failed };
}
export async function run(argv) {
    const rc = await shipImpl(argv);
    if (process.env.__CHI_NESTED !== "1" && !isDry()) {
        await maybePrintUpdateNotice();
    }
    return rc;
}
/**
 * Recurse `ship` into every submodule declared in .gitmodules, fast-forward
 * pulling each on a branch first so the parent commit can include any pointer
 * bumps the children produce. No-op when the repo has no .gitmodules.
 *
 * Submodule errors never abort the parent ship — they're collected and printed
 * at the end so a single bad submodule can't block the rest.
 */
async function shipSubmodules(repoRoot, dry) {
    const gmodPath = join(repoRoot, ".gitmodules");
    if (!existsSync(gmodPath))
        return;
    const failed = [];
    const cfg = git(["-C", repoRoot, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).stdout;
    for (const ln of cfg.split(/\r?\n/)) {
        const trimmed = ln.trim();
        if (!trimmed)
            continue;
        const smPath = trimmed.split(/\s+/, 2)[1];
        if (!smPath)
            continue;
        if (dry) {
            dryNote(`would init/update submodule ${c.cyan(smPath)}`);
        }
        else {
            const init = git(["-C", repoRoot, "submodule", "update", "--init", "--", smPath]);
            if (!init.ok) {
                failed.push(`${smPath} (init failed)`);
                process.stderr.write(`chi ship: submodule update failed for '${smPath}' — skipping (continuing)\n`);
                continue;
            }
        }
        const smAbs = join(repoRoot, smPath);
        if (!existsSync(join(smAbs, ".git"))) {
            if (dry) {
                dryNote(`submodule ${c.cyan(smPath)} not checked out — would recurse after init`);
            }
            continue;
        }
        // The .git entry can exist yet be unusable: a stale gitlink left behind
        // when a previous superproject layout was dismantled points at a
        // .git/modules/… dir that no longer exists, so every git command inside
        // fails with exit 128. Without this guard we'd misread that 128 as a
        // detached HEAD below, then recurse `ship` into the dir — where
        // isInsideRepo() is false, so it falls through to workspace-root mode
        // and reports a spurious "ship failed". Verify it's a real repo first.
        if (!git(["-C", smAbs, "rev-parse", "--git-dir"]).ok) {
            process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} ${c.cyan(smPath)} has a .git entry but is not a valid repo ${c.dim("(stale/orphaned gitlink) — skipping")}\n`);
            continue;
        }
        // ff-pull on a branch only.
        if (git(["-C", smAbs, "symbolic-ref", "-q", "HEAD"]).ok) {
            if (dry) {
                dryNote(`would pull --ff-only in ${c.cyan(smPath)}`);
            }
            else {
                const ff = git(["-C", smAbs, "pull", "--ff-only", "--quiet"]);
                if (!ff.ok) {
                    process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} pull failed in ${c.cyan(smPath)} ${c.dim("(continuing)")}\n`);
                }
            }
        }
        else {
            process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} ${c.cyan(smPath)} is in detached HEAD, ${c.dim("skipping pull")}\n`);
        }
        const subRc = await execInherit(process.execPath, [SELF_BIN, "ship"], {
            cwd: smAbs,
            env: {
                ...process.env,
                __CHI_NESTED: "1",
                ...(dry ? { [DRY_ENV]: "1" } : {}),
            },
        });
        if (subRc !== 0) {
            failed.push(`${smPath} (ship failed)`);
            process.stderr.write(`${sym.err} ${c.dim(`${BIN_NAME} ship:`)} ship failed in ${c.cyan(`'${smPath}'`)} ${c.dim("(continuing)")}\n`);
        }
    }
    if (failed.length > 0) {
        process.stderr.write(`\n${sym.err} ${c.red(`${BIN_NAME} ship: ${failed.length} submodule(s) had errors:`)}\n`);
        for (const f of failed)
            process.stderr.write(`  ${c.red("-")} ${f}\n`);
    }
}
/**
 * Bring the main repo up to date before commit/push: ff-only pull first, then
 * fall back to `pull --rebase --autostash`. Recovers from untracked files that
 * block the merge (backed up aside) and from autostash-pop conflicts (routed
 * through the conflict resolver).
 *
 * Returns a `PhaseResult`: a number to abort ship with, or null to continue.
 */
async function syncMainRepo(repoRoot, dry) {
    const onBranchWithUpstream = git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok &&
        git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok;
    if (dry) {
        if (onBranchWithUpstream) {
            dryNote(`would pull ${c.cyan(basename(repoRoot))} (ff-only, rebase on fallback)`);
        }
        return null;
    }
    if (!onBranchWithUpstream)
        return null;
    const ff = git(["-C", repoRoot, "pull", "--ff-only", "--autostash"]);
    if (!ff.ok) {
        process.stderr.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} ff-only pull failed in ${c.cyan(basename(repoRoot))} ${c.dim("— trying pull --rebase --autostash")}\n`);
        let rb = git(["-C", repoRoot, "pull", "--rebase", "--autostash"]);
        process.stdout.write(rb.stdout);
        process.stderr.write(rb.stderr);
        // Recovery: --autostash only handles tracked changes. If untracked
        // files (typically build artifacts) block the merge, move them aside
        // into .git/chi-overwrite-backup-<ts>/ and retry once.
        if (!rb.ok) {
            const blocking = parseOverwrittenUntracked(rb.stderr);
            if (blocking.length > 0) {
                process.stderr.write(`${c.dim(`${BIN_NAME} ship: ${blocking.length} untracked file(s) block the pull — moving aside and retrying`)}\n`);
                const { backupDir, moved, failed } = backupBlockingFiles(repoRoot, blocking);
                if (failed.length > 0) {
                    process.stderr.write(`${BIN_NAME} ship: could not move ${failed.length} file(s); aborting:\n`);
                    for (const f of failed)
                        process.stderr.write(`  - ${f}\n`);
                    return 1;
                }
                process.stderr.write(`${c.dim(`${BIN_NAME} ship: moved ${moved} file(s) → ${backupDir.replace(/\\/g, "/")}`)}\n`);
                rb = git(["-C", repoRoot, "pull", "--rebase", "--autostash"]);
                process.stdout.write(rb.stdout);
                process.stderr.write(rb.stderr);
            }
        }
        if (!rb.ok) {
            const innerDir = git(["-C", repoRoot, "rev-parse", "--git-dir"]).stdout.trim();
            const inRebase = existsSync(join(innerDir, "rebase-merge")) || existsSync(join(innerDir, "rebase-apply"));
            if (inRebase) {
                const result = await resolveConflicts(repoRoot);
                const rc = finalizeRebase(repoRoot, result);
                if (rc !== 0)
                    return rc;
                // Rebase succeeded after resolution — continue with ship
            }
            else {
                process.stderr.write(`${sym.err} ${c.red(`${BIN_NAME} ship:`)} pull failed in ${c.cyan(basename(repoRoot))} ${c.dim("— resolve manually and retry")}\n`);
                return 1;
            }
        }
    }
    // --autostash pop can leave unmerged paths in the index even when the
    // pull itself returned success (ff/rebase worked, but the stash didn't
    // re-apply cleanly). Those bypass the rebase-conflict branch above, so
    // check explicitly and route them through the same resolver.
    const postPullGitDir = git(["-C", repoRoot, "rev-parse", "--git-dir"]).stdout.trim();
    const stillInRebase = existsSync(join(postPullGitDir, "rebase-merge")) ||
        existsSync(join(postPullGitDir, "rebase-apply"));
    if (!stillInRebase) {
        const unmerged = git([
            "-C", repoRoot, "diff", "--name-only", "--diff-filter=U",
        ]).stdout.trim();
        if (unmerged) {
            const count = unmerged.split(/\r?\n/).filter(Boolean).length;
            process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} autostash pop left ${c.yellow(`${count} file(s)`)} ${c.dim("with conflicts — invoking resolver")}\n`);
            const result = await resolveConflicts(repoRoot);
            if (result.aborted || result.skipped > 0) {
                process.stderr.write(`${BIN_NAME} ship: ${result.skipped} file(s) unresolved after autostash pop — resolve manually and retry\n`);
                return 1;
            }
        }
    }
    return null;
}
/**
 * Flow mode (.git/chi-flow present): commit on the flow branch, push
 * -u origin <branch>, and on first call open a draft PR via gh (injecting
 * "Closes #N" when the flow tracks an issue). Always terminal — returns the
 * exit code ship should use.
 */
async function shipFlow(repoRoot, marker, dry) {
    const m = readMarker(marker);
    const base = m.base || "main";
    const cur = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    if (cur !== m.branch) {
        process.stderr.write(`chi ship: marker says flow branch '${m.branch}' but HEAD is '${cur}'\n`);
        return 1;
    }
    if (!commandExists("gh")) {
        process.stderr.write(`${BIN_NAME} ship: missing dependency: gh (required in flow mode)\n`);
        return 1;
    }
    const flowLabel = m.pr
        ? `flow: ${m.branch} → ${base}, PR #${m.pr}`
        : `flow: ${m.branch} → ${base}`;
    process.stdout.write(`\n${c.bold(c.cyan(`── repo: ${basename(repoRoot)} (${flowLabel}) ──`))}\n`);
    // Auto-bump version metadata on top-level ships with pending changes.
    if (process.env.__CHI_NESTED !== "1") {
        const flowDirty = git(["-C", repoRoot, "status", "--porcelain"]).stdout.trim();
        if (flowDirty)
            await maybeBumpVersions(repoRoot);
    }
    const commitRc = await commitRun(dry ? ["--dry-run"] : ["--yes"]);
    if (commitRc !== 0)
        return commitRc;
    if (dry) {
        dryNote(`would push -u origin ${c.cyan(m.branch)}`);
        if (!m.pr) {
            dryNote(`would open draft PR via gh: ${c.cyan(m.branch)} → ${c.cyan(base)}`);
        }
        else {
            dryNote(`would update PR #${m.pr}`);
        }
        return 0;
    }
    const pushRc = await pushWithRecovery({ args: ["-u", "origin", m.branch] });
    if (pushRc !== 0)
        return pushRc;
    if (!m.pr) {
        const ahead = git(["log", `origin/${base}..${m.branch}`, "--oneline"]).stdout.trim();
        if (!ahead) {
            process.stderr.write(`chi ship: no commits on '${m.branch}' beyond '${base}' yet — skipping PR creation\n`);
            return 0;
        }
        const createArgs = ["pr", "create", "--draft", "--base", base, "--head", m.branch];
        if (m.issue) {
            // Build title/body explicitly so we can inject "Closes #N" — GitHub's
            // auto-close keyword. `--fill` would otherwise pull body from commit
            // messages, which usually don't contain the magic phrase.
            const log = git(["log", "-1", "--format=%B", m.branch]).stdout;
            const lines = log.split(/\r?\n/);
            const title = (lines.shift() ?? "").trim() || `fix: issue #${m.issue}`;
            while (lines.length && (lines[0] ?? "").trim() === "")
                lines.shift();
            const bodyText = lines.join("\n").trim();
            const closes = `Closes #${m.issue}`;
            const body = bodyText.length === 0
                ? closes
                : bodyText.includes(closes)
                    ? bodyText
                    : `${bodyText}\n\n${closes}`;
            createArgs.push("--title", title, "--body", body);
        }
        else {
            createArgs.push("--fill");
        }
        const create = execSync("gh", createArgs);
        if (!create.ok) {
            process.stderr.write(create.stderr);
            return create.status ?? 1;
        }
        const url = create.stdout.trim();
        const match = url.match(/\/pull\/(\d+)/);
        const newPr = match ? match[1] : "";
        if (!newPr) {
            process.stderr.write(`chi ship: failed to parse PR number from gh output: ${url}\n`);
            return 1;
        }
        appendFileSync(marker, `pr=${newPr}\n`);
        process.stdout.write(`\n${sym.arrow} ${c.bold("draft PR:")} ${c.cyan(url)}\n`);
    }
    else {
        process.stdout.write(`\n${sym.arrow} ${c.bold(`updated PR #${m.pr}`)}\n`);
    }
    return 0;
}
/**
 * If HEAD is detached, switch back to a real branch before deciding
 * clean/dirty. Prefers the flow marker's branch, then any local branch
 * containing the commit, then a remote-tracking branch (creating/fast-forward
 * a local branch for it). Best-effort: only prints on failure, never aborts.
 */
function recoverDetachedHead(repoRoot, marker, dry) {
    if (git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok)
        return;
    if (dry) {
        dryNote(`detached HEAD — would attempt recovery to a tracking branch`);
        return;
    }
    const detachedSha = git(["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
    let recoverBranch = "";
    let recoverFromRemote = false;
    if (existsSync(marker)) {
        recoverBranch = readMarker(marker).branch;
        if (recoverBranch &&
            !git(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${recoverBranch}`]).ok) {
            recoverBranch = "";
        }
    }
    if (!recoverBranch) {
        const list = git([
            "-C",
            repoRoot,
            "for-each-ref",
            "--format=%(refname:short)",
            "--contains",
            detachedSha,
            "refs/heads/",
        ]).stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        recoverBranch = list[0] ?? "";
    }
    if (!recoverBranch) {
        // Common for submodules: the parent pins a SHA that lives on a remote
        // branch but no local branch has been created for it yet. Fall back to
        // remote-tracking refs and create/fast-forward a local branch.
        const remoteList = git([
            "-C", repoRoot, "for-each-ref",
            "--format=%(refname:short)",
            "--contains", detachedSha,
            "refs/remotes/origin/",
        ]).stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s && !s.endsWith("/HEAD"));
        if (remoteList.length > 0) {
            const headRef = git([
                "-C", repoRoot, "symbolic-ref", "--quiet", "--short",
                "refs/remotes/origin/HEAD",
            ]);
            const preferred = headRef.ok ? headRef.stdout.trim() : "";
            const pick = preferred && remoteList.includes(preferred)
                ? preferred
                : remoteList[0];
            recoverBranch = pick.replace(/^origin\//, "");
            recoverFromRemote = true;
        }
    }
    if (recoverBranch) {
        let co;
        if (recoverFromRemote) {
            const remoteRef = `origin/${recoverBranch}`;
            const localExists = git([
                "-C", repoRoot, "show-ref", "--verify", "--quiet",
                `refs/heads/${recoverBranch}`,
            ]).ok;
            // Only fast-forward an existing local branch — never reset one that
            // has commits the remote doesn't contain. If it has diverged, fall
            // back to a plain checkout and let the user reconcile.
            const safeToReset = !localExists ||
                git([
                    "-C", repoRoot, "merge-base", "--is-ancestor",
                    recoverBranch, remoteRef,
                ]).ok;
            co = safeToReset
                ? git(["-C", repoRoot, "checkout", "-B", recoverBranch, remoteRef])
                : git(["-C", repoRoot, "checkout", recoverBranch]);
        }
        else {
            co = git(["-C", repoRoot, "checkout", recoverBranch]);
        }
        if (co.ok) {
            const trackingNote = recoverFromRemote
                ? c.dim(` (tracking origin/${recoverBranch})`)
                : "";
            process.stdout.write(`${sym.ok} ${c.dim(`${BIN_NAME} ship:`)} recovered from detached HEAD, switched to ${c.cyan(`'${recoverBranch}'`)}${trackingNote}\n`);
        }
        else {
            process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} detached HEAD at ${c.yellow(detachedSha.slice(0, 12))} ${c.dim(`(could not recover to '${recoverBranch}')`)}\n`);
        }
    }
    else {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} detached HEAD at ${c.yellow(detachedSha.slice(0, 12))} ${c.dim("(no local or remote branch contains this commit)")}\n`);
    }
}
/**
 * Rebase the current feature branch onto the remote default branch (origin's
 * HEAD, else main/master) when it's behind, so a PR back to the default branch
 * is always trivially mergeable. Refuses to proceed if origin/<branch> has
 * commits not in HEAD (a force-with-lease would lose them).
 *
 * Returns `{ rc, needForceWithLease }`: rc is a `PhaseResult` (number to abort,
 * null to continue); needForceWithLease is true when the rebase rewrote history
 * and the eventual push must use --force-with-lease.
 */
async function rebaseOntoDefault(repoRoot, dry) {
    let needForceWithLease = false;
    const onBranch = git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok;
    if (dry) {
        if (onBranch) {
            const curBranch = git(["-C", repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
            dryNote(`would fetch origin and rebase ${c.cyan(curBranch)} onto default branch if behind`);
        }
        return { rc: null, needForceWithLease };
    }
    if (!onBranch)
        return { rc: null, needForceWithLease };
    const curBranch = git(["-C", repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
    const headRef = git([
        "-C", repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
    ]);
    let defaultBranch = "";
    if (headRef.ok) {
        defaultBranch = headRef.stdout.trim().replace(/^origin\//, "");
    }
    else {
        for (const cand of ["main", "master"]) {
            if (git([
                "-C", repoRoot, "show-ref", "--verify", "--quiet",
                `refs/remotes/origin/${cand}`,
            ]).ok) {
                defaultBranch = cand;
                break;
            }
        }
    }
    if (defaultBranch && curBranch && curBranch !== defaultBranch) {
        // Full fetch first so the user's configured refspec runs as usual.
        const fetch = git(["-C", repoRoot, "fetch", "origin"]);
        if (!fetch.ok) {
            process.stderr.write(`${c.dim(`${BIN_NAME} ship: fetch origin failed — skipping rebase`)}\n`);
        }
        else {
            // Force-fetch <curBranch> and <defaultBranch> into their explicit
            // remote-tracking refs, bypassing any narrowed origin.fetch refspec
            // (e.g. one that only covers main). Without this, --force-with-lease
            // fails with "stale info" because refs/remotes/origin/<curBranch>
            // is missing or out of date. <curBranch> is best-effort because the
            // branch may not exist on remote yet.
            git([
                "-C", repoRoot, "fetch", "origin",
                `+refs/heads/${curBranch}:refs/remotes/origin/${curBranch}`,
            ]);
            git([
                "-C", repoRoot, "fetch", "origin",
                `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
            ]);
            // Safety: refuse to force-push if origin/<curBranch> has commits not
            // in HEAD — a force-with-lease would silently lose them.
            const remoteCurRef = `refs/remotes/origin/${curBranch}`;
            const remoteCurExists = git([
                "-C", repoRoot, "show-ref", "--verify", "--quiet", remoteCurRef,
            ]).ok;
            if (remoteCurExists) {
                const aheadStr = git([
                    "-C", repoRoot, "rev-list", "--count", `HEAD..origin/${curBranch}`,
                ]).stdout.trim();
                const remoteAhead = Number.parseInt(aheadStr, 10) || 0;
                if (remoteAhead > 0) {
                    process.stderr.write(`${BIN_NAME} ship: origin/${curBranch} has ${remoteAhead} commit(s) not in HEAD — sync first (git pull --rebase) and retry\n`);
                    return { rc: 1, needForceWithLease };
                }
            }
            const behindStr = git([
                "-C", repoRoot, "rev-list", "--count", `HEAD..origin/${defaultBranch}`,
            ]).stdout.trim();
            const behind = Number.parseInt(behindStr, 10) || 0;
            if (behind > 0) {
                const headBefore = git(["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
                process.stdout.write(`${c.dim(`${BIN_NAME} ship: ${curBranch} is ${behind} commit(s) behind origin/${defaultBranch} — rebasing`)}\n`);
                const rb = git([
                    "-C", repoRoot, "rebase", "--autostash", `origin/${defaultBranch}`,
                ]);
                process.stdout.write(rb.stdout);
                process.stderr.write(rb.stderr);
                if (!rb.ok) {
                    const innerDir = git([
                        "-C", repoRoot, "rev-parse", "--git-dir",
                    ]).stdout.trim();
                    const inRebase = existsSync(join(innerDir, "rebase-merge")) ||
                        existsSync(join(innerDir, "rebase-apply"));
                    if (inRebase) {
                        const result = await resolveConflicts(repoRoot);
                        const rc = finalizeRebase(repoRoot, result);
                        if (rc !== 0)
                            return { rc, needForceWithLease };
                    }
                    else {
                        process.stderr.write(`${BIN_NAME} ship: rebase onto origin/${defaultBranch} failed — resolve manually and retry\n`);
                        return { rc: 1, needForceWithLease };
                    }
                }
                const headAfter = git(["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
                if (headAfter !== headBefore) {
                    needForceWithLease = true;
                }
            }
        }
    }
    return { rc: null, needForceWithLease };
}
/**
 * Final phase: commit + push the worktree. When clean, prints a one-line status
 * (and still force-pushes if an earlier rebase rewrote history), plus a hint
 * pointing at any chi-managed worktree with an active flow. Auto-bumps version
 * metadata on dirty top-level ships so the bump joins the same commit.
 */
async function finalizeShip(repoRoot, dry, needForceWithLease) {
    // Compact path: nothing in the working tree → one-line status, skip commit.
    const dirty = git(["-C", repoRoot, "status", "--porcelain"]).stdout.trim();
    // Auto-bump version metadata on top-level ships when there are pending
    // changes — the bump joins the same commit instead of producing churn-only
    // commits. Skips submodule recursion (__CHI_NESTED).
    if (dirty && process.env.__CHI_NESTED !== "1") {
        await maybeBumpVersions(repoRoot);
    }
    if (!dirty) {
        if (needForceWithLease) {
            process.stdout.write(`\n${c.bold(c.cyan(`── repo: ${basename(repoRoot)} (rebased) ──`))}\n`);
            if (dry) {
                dryNote(`would push --force-with-lease`);
            }
            else {
                const rc = await pushWithRecovery({
                    args: ["--force-with-lease"],
                    cwd: repoRoot,
                });
                if (rc !== 0)
                    return rc;
            }
        }
        else {
            process.stdout.write(`${sym.ok} ${c.bold(basename(repoRoot))}${c.dim(":")} ${c.green("clean")}\n`);
        }
        // Worktree-aware hint: if the source repo is clean but a chi-managed
        // worktree has an active flow, the user probably ran ship from the wrong
        // directory. Point them at it. (This is the common pitfall after
        // `chi issue fix N` — claude's work lives in ../<repo>-issue-N.)
        const flows = listActiveChiFlows();
        if (flows.length > 0) {
            process.stdout.write(`\n${c.bold(c.yellow("note:"))} active flow(s) in chi-managed worktree(s):\n`);
            for (const f of flows) {
                const tag = f.flow.issue ? c.magenta(` (issue #${f.flow.issue})`) : "";
                process.stdout.write(`  ${c.bold(c.cyan(f.flow.branch))}${tag}\n`);
                process.stdout.write(`    ${sym.arrow} ${c.dim(`cd ${f.worktreePath} && ${BIN_NAME} ship`)}\n`);
            }
        }
        return 0;
    }
    process.stdout.write(`\n${c.bold(c.cyan(`── repo: ${basename(repoRoot)} ──`))}\n`);
    let rc;
    if (git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok) {
        if (dry) {
            rc = await commitRun(["--dry-run"]);
            if (rc !== 0)
                return rc;
            dryNote(needForceWithLease
                ? `would push --force-with-lease`
                : `would commit + push`);
        }
        else if (needForceWithLease) {
            rc = await commitRun(["--yes"]);
            if (rc !== 0)
                return rc;
            rc = await pushWithRecovery({
                args: ["--force-with-lease"],
                cwd: repoRoot,
            });
        }
        else {
            rc = await commitRun(["--push", "--yes"]);
        }
    }
    else {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} still in detached HEAD, ${c.yellow("committing without push")}\n`);
        rc = await commitRun(dry ? ["--dry-run"] : ["--yes"]);
    }
    return rc;
}
/**
 * Orchestrates the ship lifecycle for the repo containing cwd:
 *   submodules → sync main → flow (terminal) → detached-HEAD recovery →
 *   rebase onto default → commit + push.
 * Falls back to workspace-root mode (globalShip) when cwd is not a git repo.
 */
async function shipImpl(argv) {
    if (argv[0] === "-h" || argv[0] === "--help") {
        process.stdout.write(HELP);
        return 0;
    }
    // Adopt --dry / --dry-run from CLI into the env so nested invocations
    // (submodules, workspace fan-out) inherit it automatically.
    if (argv.includes("--dry") || argv.includes("--dry-run")) {
        process.env[DRY_ENV] = "1";
    }
    const cleanArgv = argv.filter((a) => a !== "--dry" && a !== "--dry-run");
    const dry = isDry();
    if (dry && process.env.__CHI_NESTED !== "1") {
        process.stdout.write(`${c.bold(c.yellow("== dry-run / training mode =="))} ${c.dim("(no writes, no pushes, no PRs)")}\n`);
    }
    if (!isInsideRepo()) {
        return globalShip(cleanArgv, SELF_BIN);
    }
    const repoRoot = git(["rev-parse", "--show-toplevel"]).stdout.trim();
    const dir = gitDir();
    if (!dir)
        return 1;
    const marker = join(dir, "chi-flow");
    // Recurse first so the parent commit can include any pointer bumps the
    // children produced.
    await shipSubmodules(repoRoot, dry);
    const syncRc = await syncMainRepo(repoRoot, dry);
    if (syncRc !== null)
        return syncRc;
    if (existsSync(marker)) {
        return shipFlow(repoRoot, marker, dry);
    }
    recoverDetachedHead(repoRoot, marker, dry);
    const { rc: rebaseRc, needForceWithLease } = await rebaseOntoDefault(repoRoot, dry);
    if (rebaseRc !== null)
        return rebaseRc;
    return finalizeShip(repoRoot, dry, needForceWithLease);
}
//# sourceMappingURL=ship.js.map