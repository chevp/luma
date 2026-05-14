import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { c } from "../ui.js";
import { BIN_NAME, BIN_TAG } from "../identity.js";
import { resolveConflicts, finalizeRebase } from "../conflict.js";
export function git(args, cwd) {
    const opts = {
        encoding: "utf8",
        cwd,
        windowsHide: true,
    };
    const r = spawnSync("git", args, opts);
    return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").toString(),
        stderr: (r.stderr ?? "").toString(),
        status: r.status,
    };
}
export function isInsideRepo() {
    return git(["rev-parse", "--git-dir"]).ok;
}
export function repoRoot() {
    return git(["rev-parse", "--show-toplevel"]).stdout.trim();
}
export function currentBranch() {
    const sym = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (sym.ok)
        return sym.stdout.trim();
    const sha = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
    return `${sha} (detached)`;
}
export function upstreamRef() {
    const r = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return r.ok ? r.stdout.trim() : null;
}
export function aheadBehind() {
    const r = git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (!r.ok)
        return { ahead: 0, behind: 0 };
    const parts = r.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(parts[0] ?? "0", 10);
    const ahead = Number.parseInt(parts[1] ?? "0", 10);
    return {
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
    };
}
export function porcelain() {
    const r = git(["status", "--porcelain=v1"]);
    const raw = r.ok ? r.stdout : "";
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const ln of raw.split("\n")) {
        if (!ln)
            continue;
        const x = ln[0] ?? " ";
        const y = ln[1] ?? " ";
        if (ln.startsWith("??")) {
            untracked++;
            continue;
        }
        if ("MADRC".includes(x))
            staged++;
        if ("MADRC".includes(y))
            unstaged++;
    }
    return { staged, unstaged, untracked, total: staged + unstaged + untracked, raw };
}
export function shortStatus() {
    return git(["-c", "color.status=always", "status", "--short"]).stdout;
}
export function recentCommits(n = 5, cwd) {
    return git([
        "-c", "color.ui=always",
        "log",
        `-n`, String(n),
        "--pretty=format:  %C(auto)%h%Creset %s %C(dim)(%cr)%Creset",
    ], cwd).stdout;
}
export function gitDir(cwd) {
    const r = git(["rev-parse", "--git-dir"], cwd);
    if (!r.ok)
        return null;
    return r.stdout.trim();
}
export function submoduleStatusRecursive(cwd) {
    return git(["submodule", "status", "--recursive"], cwd).stdout;
}
/**
 * Append a structured failure record so `chi explain` can read it later. The
 * log lives at <gitDir>/chi-last-error.log — one per repo, overwritten on each
 * failure.
 */
export function recordError(cmd, exitCode, output, cwd) {
    const dir = gitDir(cwd);
    if (!dir)
        return;
    const ts = new Date().toISOString();
    const status = git(["status", "-sb"], cwd).stdout || "";
    const log = git(["log", "-5", "--oneline"], cwd).stdout || "";
    const remote = git(["remote", "-v"], cwd).stdout || "";
    const body = `${BIN_TAG} error log\n` +
        `timestamp: ${ts}\n` +
        `command:   ${cmd}\n` +
        `exit:      ${exitCode ?? "?"}\n` +
        `cwd:       ${process.cwd()}\n` +
        `\n--- output ---\n${output}\n` +
        `\n--- git status -sb ---\n${status}` +
        `\n--- git log -5 --oneline ---\n${log}` +
        `\n--- git remote -v ---\n${remote}`;
    try {
        writeFileSync(`${dir}/chi-last-error.log`, body);
    }
    catch {
        /* ignore */
    }
}
/**
 * `git push` with a single recoverable retry on non-fast-forward / fetch-first
 * rejections. On reject:
 *   1) `git pull --rebase`,
 *   2) if the rebase produces conflicts → abort and surface them,
 *   3) otherwise retry the push exactly once.
 *
 * Logs unrecoverable failures to <gitDir>/chi-last-error.log and points the
 * user at `chi explain`.
 */
export async function pushWithRecovery(opts = {}) {
    let args = opts.args ?? [];
    const cwd = opts.cwd;
    // First push of a fresh branch: if no upstream is configured and the caller
    // didn't already pass -u/--set-upstream, set it automatically so `chi ship`
    // works on a branch that was just created locally.
    const hasUpstreamFlag = args.some((a) => a === "-u" || a === "--set-upstream");
    if (!hasUpstreamFlag) {
        const sym = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
        if (sym.ok) {
            const branch = sym.stdout.trim();
            const ups = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
            if (branch && !ups.ok) {
                args = ["-u", "origin", branch, ...args];
            }
        }
    }
    const cmd = `git push ${args.join(" ")}`.trim();
    const first = git(["push", ...args], cwd);
    process.stdout.write(first.stdout);
    if (first.ok)
        return 0;
    const out = first.stderr || first.stdout;
    const rejected = /rejected.*(fetch first|non-fast-forward)|Updates were rejected/.test(out);
    if (!rejected) {
        process.stderr.write(out);
        // Archived repo: GitHub returns 403 with a "This repository was archived"
        // notice. The remediation is concrete (unarchive or repoint origin), so
        // surface it directly rather than pointing the user at `chi explain`.
        if (/This repository was archived so it is read-only/i.test(out)) {
            process.stderr.write(`\n${c.red(`${BIN_NAME} ship: push refused — remote repository is archived (read-only)`)}\n` +
                `unarchive on GitHub, or repoint the remote: ${c.dim("git remote set-url origin <new-url>")}\n`);
            return first.status ?? 1;
        }
        recordError(cmd, first.status, out, cwd);
        process.stderr.write(`\n${c.red(`${BIN_NAME} ship: push failed (exit ${first.status ?? "?"})`)}\n` +
            `run ${c.dim(`${BIN_NAME} explain`)} for an LLM-assisted diagnosis\n`);
        return first.status ?? 1;
    }
    process.stderr.write(`${c.dim(`${BIN_NAME} ship: remote moved — pulling --rebase, retrying push`)}\n`);
    const rebase = git(["pull", "--rebase"], cwd);
    if (!rebase.ok) {
        process.stderr.write(out);
        process.stderr.write(c.dim(rebase.stderr || rebase.stdout));
        const dir = gitDir(cwd);
        const inRebase = dir !== null && (existsSync(`${dir}/rebase-merge`) || existsSync(`${dir}/rebase-apply`));
        if (inRebase) {
            // Attempt interactive conflict resolution via claude
            const repoPath = cwd ?? process.cwd();
            const result = await resolveConflicts(repoPath);
            const rc = finalizeRebase(repoPath, result);
            if (rc !== 0) {
                recordError(`${cmd} → pull --rebase conflicts`, rebase.status, rebase.stderr || rebase.stdout, cwd);
                process.stderr.write(`\nrun ${c.dim(`${BIN_NAME} explain`)} for an LLM-assisted diagnosis\n`);
                return rc;
            }
            // Resolution succeeded — fall through to retry push
        }
        else {
            recordError(`${cmd} → pull --rebase failed`, rebase.status, rebase.stderr || rebase.stdout, cwd);
            process.stderr.write(`\nrun ${c.dim(`${BIN_NAME} explain`)} for an LLM-assisted diagnosis\n`);
            return rebase.status ?? 1;
        }
    }
    const retry = git(["push", ...args], cwd);
    process.stdout.write(retry.stdout);
    if (retry.ok) {
        process.stderr.write(`${c.green("✓ push succeeded after rebase")}\n`);
        return 0;
    }
    const retryOut = retry.stderr || retry.stdout;
    process.stderr.write(retryOut);
    recordError(`${cmd} (after pull --rebase)`, retry.status, retryOut, cwd);
    process.stderr.write(`\n${c.red(`${BIN_NAME} ship: push still failing after one retry`)}\n` +
        `run ${c.dim(`${BIN_NAME} explain`)} for an LLM-assisted diagnosis\n`);
    return retry.status ?? 1;
}
//# sourceMappingURL=index.js.map