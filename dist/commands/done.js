import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commandExists, execSync } from "../spawn.js";
import { git, gitDir, isInsideRepo } from "../git/index.js";
import { readMarker } from "./flow.js";
import { detectChiWorktree } from "./work.js";
import { BIN_NAME } from "../identity.js";
const HELP = `${BIN_NAME} done — finish the active ${BIN_NAME} flow.

Reads .git/chi-flow, then runs:
  gh pr merge <pr> --squash --auto --delete-branch
  git checkout <base> && git pull --ff-only && git remote prune origin

Options:
  --issue <n>   close GitHub issue #n after merge (overrides marker;
                useful when the flow was started via '${BIN_NAME} flow' rather
                than '${BIN_NAME} issue fix')
  -h, --help    show this help

Aborts if there's no active flow, or no PR yet (run '${BIN_NAME} ship' first).
`;
export async function run(argv) {
    let issueOverride = "";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "-h" || a === "--help") {
            process.stdout.write(HELP);
            return 0;
        }
        if (a === "--issue") {
            const v = argv[++i];
            if (!v) {
                process.stderr.write(`${BIN_NAME} done: --issue needs a value\n`);
                return 1;
            }
            if (!/^\d+$/.test(v)) {
                process.stderr.write(`${BIN_NAME} done: --issue '${v}' is not a valid issue number\n`);
                return 1;
            }
            issueOverride = v;
            continue;
        }
        process.stderr.write(`${BIN_NAME} done: unknown option '${a}'\n`);
        return 1;
    }
    for (const bin of ["git", "gh"]) {
        if (!commandExists(bin)) {
            process.stderr.write(`${BIN_NAME} done: missing dependency: ${bin} (run '${BIN_NAME} doctor git')\n`);
            return 1;
        }
    }
    if (!isInsideRepo()) {
        process.stderr.write(`${BIN_NAME} done: not a git repository\n`);
        return 1;
    }
    const dir = gitDir();
    if (!dir)
        return 1;
    const marker = join(dir, "chi-flow");
    if (!existsSync(marker)) {
        process.stderr.write(`${BIN_NAME} done: no active flow (${marker} missing) — run '${BIN_NAME} flow <branch>' first\n`);
        return 1;
    }
    const m = readMarker(marker);
    if (!m.branch) {
        process.stderr.write(`${BIN_NAME} done: marker missing 'branch' field\n`);
        return 1;
    }
    const base = m.base || "main";
    if (!m.pr) {
        process.stderr.write(`${BIN_NAME} done: no PR recorded yet — run '${BIN_NAME} ship' first to create one\n`);
        return 1;
    }
    const cur = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    if (cur !== m.branch) {
        process.stderr.write(`${BIN_NAME} done: HEAD is on '${cur}' but flow branch is '${m.branch}' — checkout it first\n`);
        return 1;
    }
    // Detect worktree mode up-front: in a chi-managed worktree, gh's
    // `--delete-branch` would try to `git checkout <base>` inside the worktree
    // to clear it before deleting the local branch — and fail because <base>
    // is checked out in the main repo. We drop the flag in worktree mode and
    // do both local + remote branch cleanup ourselves below.
    const wt = detectChiWorktree();
    let mergeMode = "auto";
    let draftPromoted = false;
    for (;;) {
        const args = ["pr", "merge", m.pr, "--squash"];
        if (mergeMode === "auto")
            args.push("--auto");
        if (!wt)
            args.push("--delete-branch");
        const r = execSync("gh", args);
        if (r.ok)
            break;
        if (mergeMode === "auto" && r.stderr.includes("enablePullRequestAutoMerge")) {
            process.stderr.write(`${BIN_NAME} done: auto-merge disabled on this repo — falling back to direct merge\n`);
            mergeMode = "direct";
            continue;
        }
        if (!draftPromoted && r.stderr.includes("is still a draft")) {
            process.stderr.write(`${BIN_NAME} done: PR #${m.pr} is a draft — marking ready, then retrying\n`);
            const ready = execSync("gh", ["pr", "ready", m.pr]);
            if (!ready.ok) {
                process.stderr.write(ready.stderr);
                return ready.status ?? 1;
            }
            draftPromoted = true;
            continue;
        }
        process.stderr.write(r.stderr);
        return r.status ?? 1;
    }
    // Worktree cleanup branch: don't disturb the source repo's HEAD, and do the
    // branch-delete dance ourselves since we dropped gh's `--delete-branch`.
    if (wt) {
        const source = wt.meta.source;
        const rm = git(["worktree", "remove", wt.worktreePath, "--force"], source);
        process.stderr.write(rm.stderr);
        if (!rm.ok) {
            process.stderr.write(`${BIN_NAME} done: 'git worktree remove' failed — clean up manually with 'git worktree prune'\n`);
            return rm.status ?? 1;
        }
        if (git(["show-ref", "--verify", "--quiet", `refs/heads/${m.branch}`], source).ok) {
            git(["branch", "-D", m.branch], source);
        }
        // Delete the remote ref ourselves. In direct merge mode the merge has
        // happened and the ref is safe to drop now. In auto mode the merge is
        // queued; deleting the remote ref would cancel it — let GitHub's
        // "automatically delete head branches" repo setting handle it instead
        // (or the user, after the queued merge completes).
        if (mergeMode === "direct") {
            git(["push", "origin", "--delete", m.branch], source); // best-effort
        }
        git(["remote", "prune", "origin"], source); // best-effort
        const issueToClose = issueOverride || m.issue;
        if (issueToClose) {
            execSync("gh", ["issue", "close", issueToClose, "--reason", "completed"], { cwd: source });
        }
        // Marker is gone with the worktree; nothing to delete locally.
        if (mergeMode === "auto") {
            process.stdout.write(`\n── flow done: PR #${m.pr} queued (auto-merge) + worktree removed ──\n`);
        }
        else {
            process.stdout.write(`\n── flow done: PR #${m.pr} merged + worktree removed ──\n`);
        }
        process.stdout.write(`note: your shell is now in a deleted directory — cd ${source}\n`);
        return 0;
    }
    const co = git(["checkout", base]);
    process.stderr.write(co.stderr);
    if (!co.ok)
        return co.status ?? 1;
    const pull = git(["pull", "--ff-only"]);
    process.stdout.write(pull.stdout);
    process.stderr.write(pull.stderr);
    if (!pull.ok)
        return pull.status ?? 1;
    git(["remote", "prune", "origin"]); // best-effort
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${m.branch}`]).ok) {
        git(["branch", "-D", m.branch]); // best-effort
    }
    // Best-effort close the linked issue. With auto-merge GitHub's "Closes #N"
    // parser handles this asynchronously, but in direct-merge mode the issue
    // closes only if the PR body had the keyword — call gh as a safety net.
    // Idempotent: closing an already-closed issue exits non-zero, which we ignore.
    const issueToClose = issueOverride || m.issue;
    if (issueToClose) {
        execSync("gh", ["issue", "close", issueToClose, "--reason", "completed"]);
    }
    try {
        rmSync(marker, { force: true });
    }
    catch {
        /* ignore */
    }
    if (mergeMode === "auto") {
        process.stdout.write(`\n── flow done: PR #${m.pr} queued (auto-merge, squash, delete-branch) ──\n`);
    }
    else {
        process.stdout.write(`\n── flow done: PR #${m.pr} merged (squash, delete-branch) ──\n`);
    }
    process.stdout.write(`back on ${base}\n`);
    return 0;
}
//# sourceMappingURL=done.js.map