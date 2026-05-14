import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists, execSync } from "../spawn.js";
import { git, gitDir, isInsideRepo } from "../git/index.js";
import { BIN_NAME } from "../identity.js";
const HELP = `${BIN_NAME} flow — start a flow branch (pull base, checkout new, mark for ${BIN_NAME} ship/done).

Usage: ${BIN_NAME} flow <branch> [--base <branch>]

Options:
  --base <branch>   base branch (default: main)
  -h, --help        show this help

Workflow:
  ${BIN_NAME} flow feat/foo     # pull main, checkout feat/foo, write marker
  ...edit...
  ${BIN_NAME} ship              # commit + push -u (creates draft PR on first call)
  ...edit...
  ${BIN_NAME} ship              # commit + push (PR auto-updates)
  ${BIN_NAME} done              # gh pr merge --squash --auto --delete-branch + back to base
`;
export async function run(argv) {
    let base = "main";
    let branch = "";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "-h" || a === "--help") {
            process.stdout.write(HELP);
            return 0;
        }
        if (a === "--base") {
            const v = argv[++i];
            if (!v) {
                process.stderr.write(`${BIN_NAME} flow: --base needs a value\n`);
                return 1;
            }
            base = v;
            continue;
        }
        if (a.startsWith("-")) {
            process.stderr.write(`${BIN_NAME} flow: unknown option '${a}'\n`);
            return 1;
        }
        if (branch) {
            process.stderr.write(`${BIN_NAME} flow: only one branch arg accepted\n`);
            return 1;
        }
        branch = a;
    }
    if (!branch) {
        process.stderr.write(`${BIN_NAME} flow: missing <branch>\n`);
        process.stderr.write(HELP);
        return 1;
    }
    for (const bin of ["git", "gh"]) {
        if (!commandExists(bin)) {
            process.stderr.write(`${BIN_NAME} flow: missing dependency: ${bin} (run '${BIN_NAME} doctor git')\n`);
            return 1;
        }
    }
    if (!isInsideRepo()) {
        process.stderr.write(`${BIN_NAME} flow: not a git repository\n`);
        return 1;
    }
    const ghAuth = execSync("gh", ["auth", "status"]);
    if (!ghAuth.ok) {
        process.stderr.write(`${BIN_NAME} flow: gh not authenticated — run: gh auth login\n`);
        return 1;
    }
    const dir = gitDir();
    if (!dir) {
        process.stderr.write(`${BIN_NAME} flow: cannot resolve git dir\n`);
        return 1;
    }
    const marker = join(dir, "chi-flow");
    if (existsSync(marker)) {
        const cur = readMarker(marker).branch;
        process.stderr.write(`${BIN_NAME} flow: active flow on '${cur}' — run '${BIN_NAME} done' first or rm ${marker}\n`);
        return 1;
    }
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
        process.stderr.write(`${BIN_NAME} flow: local branch '${branch}' already exists\n`);
        return 1;
    }
    const fetch = git(["fetch", "origin", "--prune"]);
    process.stderr.write(fetch.stderr);
    if (!fetch.ok)
        return fetch.status ?? 1;
    if (!git(["show-ref", "--verify", "--quiet", `refs/heads/${base}`]).ok) {
        process.stderr.write(`${BIN_NAME} flow: base branch '${base}' does not exist locally\n`);
        return 1;
    }
    const co1 = git(["checkout", base]);
    process.stderr.write(co1.stderr);
    if (!co1.ok)
        return co1.status ?? 1;
    const pull = git(["pull", "--ff-only"]);
    process.stdout.write(pull.stdout);
    process.stderr.write(pull.stderr);
    if (!pull.ok)
        return pull.status ?? 1;
    const co2 = git(["checkout", "-b", branch]);
    process.stderr.write(co2.stderr);
    if (!co2.ok)
        return co2.status ?? 1;
    writeFileSync(marker, `branch=${branch}\nbase=${base}\n`);
    process.stdout.write(`\n── flow started: ${branch} (base: ${base}) ──\n`);
    process.stdout.write(`next: edit, then "${BIN_NAME} ship" to commit + push (draft PR on first call)\n`);
    return 0;
}
export function readMarker(path) {
    const out = { branch: "", base: "", pr: "", issue: "" };
    try {
        const raw = readFileSync(path, "utf8");
        for (const line of raw.split(/\r?\n/)) {
            const eq = line.indexOf("=");
            if (eq < 0)
                continue;
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim();
            if (k === "branch")
                out.branch = v;
            else if (k === "base")
                out.base = v;
            else if (k === "pr")
                out.pr = v;
            else if (k === "issue")
                out.issue = v;
        }
    }
    catch {
        /* ignore */
    }
    return out;
}
//# sourceMappingURL=flow.js.map