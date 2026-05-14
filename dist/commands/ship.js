import { basename, dirname, join } from "node:path";
import { existsSync, appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { commandExists, execInherit, execSync } from "../spawn.js";
import { git, gitDir, isInsideRepo, pushWithRecovery } from "../git/index.js";
import { resolveConflicts, finalizeRebase } from "../conflict.js";
import { c, sym } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { readMarker } from "./flow.js";
import { run as commitRun } from "./commit.js";
import { listActiveChiFlows } from "./work.js";
import { discoverRepos, repoLabel } from "../workspace.js";
const HELP = `${BIN_NAME} ship — for this repo and every submodule (recursively):
  init if missing, fast-forward pull if on a branch, then add + commit + push.

In flow mode (.git/chi-flow present): commit, push -u origin <branch>, and on
first call open a draft PR via gh.

Workspace-root mode (cwd is not a git repo):
  Discover repos one or two levels deep, optionally clone any missing repos
  via misc/chevp-setup/clone-all.py, then run \`${BIN_NAME} ship\` in each.
`;
const SELF_BIN = process.argv[1] ?? "chi";
/**
 * Bump the patch field of <repoRoot>/package.json (e.g. 0.1.0 → 0.1.1).
 *
 * Returns the new version string on success, null when there is no package.json
 * (non-Node repos ship as before), or null when the current `version` is not
 * parseable as semver. Preserves any pre-release / build suffix verbatim.
 *
 * Indentation is detected from the file (defaults to 2 spaces) so the diff
 * stays minimal. Only callers that have already verified the working tree is
 * dirty AND that the call is top-level (process.env.__CHI_NESTED !== "1")
 * should invoke this — the function itself does no such guarding.
 */
function maybeBumpPatchVersion(repoRoot) {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath))
        return null;
    let raw;
    try {
        raw = readFileSync(pkgPath, "utf8");
    }
    catch {
        return null;
    }
    let pkg;
    try {
        pkg = JSON.parse(raw);
    }
    catch {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} package.json is not valid JSON, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    if (typeof pkg.version !== "string") {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} package.json has no string version, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(pkg.version);
    if (!m) {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} version '${pkg.version}' is not parseable semver, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    const oldVersion = pkg.version;
    const next = `${m[1]}.${m[2]}.${Number.parseInt(m[3] ?? "0", 10) + 1}${m[4] ?? ""}`;
    // Detect indent from the first indented line; default to 2 spaces.
    const indentMatch = /\n([ \t]+)"/.exec(raw);
    const indent = indentMatch?.[1] ?? "  ";
    const trailingNewline = raw.endsWith("\n") ? "\n" : "";
    pkg.version = next;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + trailingNewline);
    process.stdout.write(`${sym.arrow} ${c.dim(`${BIN_NAME} ship:`)} bumped ${c.cyan("package.json")} ${c.dim(oldVersion + " →")} ${c.green(next)}\n`);
    return next;
}
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
/**
 * Workspace-root mode: discover repos under cwd and ship each.
 *
 * Before iterating, attempts to clone any repos listed in repo-map.json
 * via chevp-setup's clone-all.py (if both python and the script are
 * available). Failures in individual repos do not abort the rest.
 */
async function globalShip(argv) {
    const cwd = process.cwd();
    const cwdFwd = cwd.replace(/\\/g, "/");
    const skipClone = argv.includes("--no-clone");
    // ---- 1. Optionally sync the workspace via chevp-setup ------------------
    const cloneScript = join(cwd, "misc", "chevp-setup", "clone-all.py");
    if (!skipClone && existsSync(cloneScript)) {
        process.stdout.write(`${c.bold(c.magenta("== sync workspace =="))}\n`);
        process.stdout.write(`  ${sym.arrow} ${c.dim(cloneScript.replace(/\\/g, "/"))}\n`);
        const py = commandExists("python")
            ? "python"
            : commandExists("python3")
                ? "python3"
                : "";
        if (!py) {
            process.stdout.write(`  ${c.yellow("python not on PATH — skipping clone-all (re-run with python installed to fetch missing repos)")}\n`);
        }
        else {
            const rc = await execInherit(py, [cloneScript], { cwd });
            if (rc !== 0) {
                process.stdout.write(`  ${c.yellow(`clone-all exited ${rc} — continuing with locally available repos`)}\n`);
            }
        }
    }
    else if (!skipClone) {
        process.stdout.write(`  ${c.dim(`(no misc/chevp-setup/clone-all.py under ${cwdFwd} — skipping repo sync)`)}\n`);
    }
    // ---- 2. Discover repos (after clone-all so newly cloned ones count) ----
    const repos = discoverRepos(cwd);
    if (repos.length === 0) {
        process.stderr.write(`${BIN_NAME} ship: no git repositories found under ${cwdFwd}\n`);
        return 1;
    }
    process.stdout.write(`\n${c.bold(c.magenta(`== ship ${repos.length} repos ==`))}\n`);
    const failures = [];
    let shipped = 0;
    for (const info of repos) {
        const label = repoLabel(info);
        process.stdout.write(`\n${c.bold(c.cyan(`── ${label} ──`))}\n`);
        const rc = await execInherit(process.execPath, [SELF_BIN, "ship"], {
            cwd: info.path,
            env: { ...process.env, __CHI_NESTED: "1" },
        });
        if (rc !== 0) {
            failures.push(label);
        }
        else {
            shipped++;
        }
    }
    process.stdout.write(`\n${c.bold(c.magenta("== summary =="))}\n`);
    const okPart = `${sym.ok} ${c.green(`${shipped}/${repos.length} ok`)}`;
    if (failures.length > 0) {
        process.stdout.write(`  ${okPart}${c.dim(",")}  ${sym.err} ${c.red(`${failures.length} failed`)}\n`);
        for (const f of failures) {
            process.stdout.write(`    ${c.red("✗")} ${f}\n`);
        }
        return 1;
    }
    process.stdout.write(`  ${okPart}\n\n`);
    return 0;
}
export async function run(argv) {
    if (argv[0] === "-h" || argv[0] === "--help") {
        process.stdout.write(HELP);
        return 0;
    }
    if (!isInsideRepo()) {
        return globalShip(argv);
    }
    const repoRoot = git(["rev-parse", "--show-toplevel"]).stdout.trim();
    const dir = gitDir();
    if (!dir)
        return 1;
    const marker = join(dir, "chi-flow");
    // --- submodules: recurse first so the parent commit can include any pointer
    // bumps the children produced.
    const gmodPath = join(repoRoot, ".gitmodules");
    if (existsSync(gmodPath)) {
        const failed = [];
        const cfg = git(["-C", repoRoot, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).stdout;
        for (const ln of cfg.split(/\r?\n/)) {
            const trimmed = ln.trim();
            if (!trimmed)
                continue;
            const smPath = trimmed.split(/\s+/, 2)[1];
            if (!smPath)
                continue;
            const init = git(["-C", repoRoot, "submodule", "update", "--init", "--", smPath]);
            if (!init.ok) {
                failed.push(`${smPath} (init failed)`);
                process.stderr.write(`chi ship: submodule update failed for '${smPath}' — skipping (continuing)\n`);
                continue;
            }
            const smAbs = join(repoRoot, smPath);
            if (!existsSync(join(smAbs, ".git")))
                continue;
            // ff-pull on a branch only.
            if (git(["-C", smAbs, "symbolic-ref", "-q", "HEAD"]).ok) {
                const ff = git(["-C", smAbs, "pull", "--ff-only", "--quiet"]);
                if (!ff.ok) {
                    process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} pull failed in ${c.cyan(smPath)} ${c.dim("(continuing)")}\n`);
                }
            }
            else {
                process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} ${c.cyan(smPath)} is in detached HEAD, ${c.dim("skipping pull")}\n`);
            }
            const subRc = await execInherit(process.execPath, [SELF_BIN, "ship"], {
                cwd: smAbs,
                env: { ...process.env, __CHI_NESTED: "1" },
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
    // --- pull main repo before commit/push: ff-only first, fall back to rebase ---
    if (git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok &&
        git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok) {
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
    }
    // --- flow mode ---
    if (existsSync(marker)) {
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
        // Auto-bump package.json patch on top-level ships with pending changes.
        if (process.env.__CHI_NESTED !== "1") {
            const flowDirty = git(["-C", repoRoot, "status", "--porcelain"]).stdout.trim();
            if (flowDirty)
                maybeBumpPatchVersion(repoRoot);
        }
        const commitRc = await commitRun(["--yes"]);
        if (commitRc !== 0)
            return commitRc;
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
    // --- detached HEAD recovery before deciding clean/dirty ---
    if (!git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok) {
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
    // --- rebase onto default branch (e.g. origin/main) before pushing ---
    // Keeps feature branches up to date with main so a PR back to main is
    // always trivially mergeable. If a rebase rewrites history, the subsequent
    // push must use --force-with-lease.
    let needForceWithLease = false;
    if (git(["-C", repoRoot, "symbolic-ref", "-q", "HEAD"]).ok) {
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
                        return 1;
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
                                return rc;
                        }
                        else {
                            process.stderr.write(`${BIN_NAME} ship: rebase onto origin/${defaultBranch} failed — resolve manually and retry\n`);
                            return 1;
                        }
                    }
                    const headAfter = git(["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
                    if (headAfter !== headBefore) {
                        needForceWithLease = true;
                    }
                }
            }
        }
    }
    // Compact path: nothing in the working tree → one-line status, skip commit.
    const dirty = git(["-C", repoRoot, "status", "--porcelain"]).stdout.trim();
    // Auto-bump package.json patch on top-level ships when there are pending
    // changes — the bump joins the same commit instead of producing churn-only
    // commits. Skips submodule recursion (__CHI_NESTED) and non-Node repos.
    if (dirty && process.env.__CHI_NESTED !== "1") {
        maybeBumpPatchVersion(repoRoot);
    }
    if (!dirty) {
        if (needForceWithLease) {
            process.stdout.write(`\n${c.bold(c.cyan(`── repo: ${basename(repoRoot)} (rebased) ──`))}\n`);
            const rc = await pushWithRecovery({
                args: ["--force-with-lease"],
                cwd: repoRoot,
            });
            if (rc !== 0)
                return rc;
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
        if (needForceWithLease) {
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
        rc = await commitRun(["--yes"]);
    }
    return rc;
}
//# sourceMappingURL=ship.js.map