import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CHI_OS } from "../platform.js";
import { BIN_NAME, BIN_TAG } from "../identity.js";
import { c, kv, line, section } from "../ui.js";
import { activeProviderName, getProvider } from "../provider/index.js";
import { aheadBehind, currentBranch, git, isInsideRepo, porcelain, recentCommits, repoRoot, shortStatus, submoduleStatusRecursive, upstreamRef, } from "../git/index.js";
import { commandExists, execSync } from "../spawn.js";
import { parseFrontmatter, parseFrontmatterFile, statusBadge } from "../frontmatter.js";
import { discoverRepos, groupByCategory, repoLabel, } from "../workspace.js";
const HELP = `${BIN_NAME} status — overview of the current repo and ${BIN_TAG} configuration.

Usage: ${BIN_NAME} status [options]

Options:
  -s, --short   only the one-line summary (no recent commits, no submodules)
  -h, --help    show this help
`;
async function fetchGhIssues(timeoutSec, cwd) {
    const r = execSync("gh", [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "5",
        "--json",
        "number,title,labels,assignees,body",
        "--jq",
        '.[] | "\\(.number)\\t\\(.title)\\t\\([.labels[].name]|join(","))\\t\\([.assignees[].login]|join(","))\\t\\(.body|@base64)"',
    ], { timeoutMs: timeoutSec * 1000, cwd });
    if (!r.ok)
        return null;
    const out = [];
    for (const ln of r.stdout.split(/\r?\n/)) {
        if (!ln)
            continue;
        const [num, title, labels, assignees, bodyB64] = ln.split("\t");
        let body = "";
        if (bodyB64) {
            try {
                body = Buffer.from(bodyB64, "base64").toString("utf8");
            }
            catch {
                body = "";
            }
        }
        out.push({
            num: num ?? "",
            title: title ?? "",
            labels: labels ?? "",
            assignees: assignees ?? "",
            body,
        });
    }
    return out;
}
async function fetchGhPrs(timeoutSec, cwd) {
    const r = execSync("gh", [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "5",
        "--json",
        "number,title,isDraft,headRefName,reviewDecision,author",
        "--jq",
        '.[] | "\\(.number)\\t\\(.title)\\t\\(.isDraft)\\t\\(.headRefName)\\t\\(.reviewDecision // "")\\t\\(.author.login)"',
    ], { timeoutMs: timeoutSec * 1000, cwd });
    if (!r.ok)
        return null;
    const out = [];
    for (const ln of r.stdout.split(/\r?\n/)) {
        if (!ln)
            continue;
        const [num, title, isDraft, head, review, author] = ln.split("\t");
        out.push({
            num: num ?? "",
            title: title ?? "",
            isDraft: isDraft === "true",
            head: head ?? "",
            review: review ?? "",
            author: author ?? "",
        });
    }
    return out;
}
function prStateTag(row) {
    if (row.isDraft)
        return c.dim("draft");
    switch (row.review) {
        case "APPROVED":
            return c.green("approved");
        case "CHANGES_REQUESTED":
            return c.red("changes-requested");
        case "REVIEW_REQUIRED":
            return c.yellow("review-required");
        case "":
            return c.dim("open");
        default:
            return c.dim(row.review);
    }
}
const MAX_DETAIL_REPOS = 15;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s) {
    return s.replace(ANSI_RE, "").length;
}
function padPlain(s, n) {
    const v = visLen(s);
    return v < n ? s + " ".repeat(n - v) : s;
}
function summarize(info) {
    const branchR = git(["symbolic-ref", "--quiet", "--short", "HEAD"], info.path);
    const branch = branchR.ok ? branchR.stdout.trim() : "detached";
    const stR = git(["status", "--porcelain=v1"], info.path);
    const dirty = stR.ok && stR.stdout.trim().length > 0;
    const logR = git(["log", "-1", "--pretty=format:%h%x09%s%x09%cr%x09%ct"], info.path);
    let lastSha = "", lastMsg = "", lastAge = "", lastTs = 0;
    if (logR.ok && logR.stdout.trim()) {
        const parts = logR.stdout.split("\t");
        lastSha = parts[0] ?? "";
        lastMsg = parts[1] ?? "";
        lastAge = parts[2] ?? "";
        lastTs = Number.parseInt(parts[3] ?? "0", 10) || 0;
    }
    const upR = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], info.path);
    const hasUpstream = upR.ok;
    let ahead = 0, behind = 0;
    if (hasUpstream) {
        const r = git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], info.path);
        if (r.ok) {
            const m = r.stdout.trim().match(/^(\d+)\s+(\d+)/);
            if (m) {
                ahead = Number.parseInt(m[1] ?? "0", 10);
                behind = Number.parseInt(m[2] ?? "0", 10);
            }
        }
    }
    const remote = git(["remote", "get-url", "origin"], info.path);
    const hasGithub = remote.ok && remote.stdout.includes("github");
    return {
        info,
        branch,
        dirty,
        lastSha,
        lastMsg,
        lastAge,
        lastTs,
        hasUpstream,
        ahead,
        behind,
        hasGithub,
    };
}
async function globalStatus(short) {
    const cwd = process.cwd().replace(/\\/g, "/");
    const repos = discoverRepos(process.cwd());
    if (repos.length === 0) {
        section("workspace");
        kv("path", cwd);
        process.stdout.write(`  ${c.dim("(no git repositories found in this directory or one level deeper)")}\n`);
        line();
        return 0;
    }
    const summaries = repos.map(summarize);
    // ---- workspace summary ---------------------------------------------------
    const dirtyCount = summaries.filter((s) => s.dirty).length;
    const aheadCount = summaries.filter((s) => s.ahead > 0).length;
    const behindCount = summaries.filter((s) => s.behind > 0).length;
    const detachedCount = summaries.filter((s) => s.branch === "detached").length;
    section("workspace");
    kv("path", cwd);
    const stats = [`${summaries.length} repos`];
    stats.push(dirtyCount > 0 ? `${c.yellow(String(dirtyCount))} dirty` : `${c.green("0")} dirty`);
    if (aheadCount > 0)
        stats.push(`${c.cyan(String(aheadCount))} ahead`);
    if (behindCount > 0)
        stats.push(`${c.red(String(behindCount))} behind`);
    if (detachedCount > 0)
        stats.push(`${c.yellow(String(detachedCount))} detached`);
    kv("status", stats.join(c.dim(" · ")));
    // ---- repositories grouped by category ------------------------------------
    const groups = groupByCategory(summaries.map((s) => s.info));
    const summaryByPath = new Map(summaries.map((s) => [s.info.path, s]));
    // Compute column widths from data
    const nameWidth = Math.min(36, Math.max(20, ...summaries.map((s) => s.info.name.length)));
    const branchWidth = Math.min(24, Math.max(8, ...summaries.map((s) => s.branch.length)));
    section("repositories");
    const cats = [...groups.keys()].sort((a, b) => {
        if (a === "" && b !== "")
            return -1;
        if (b === "" && a !== "")
            return 1;
        return a.localeCompare(b);
    });
    for (const cat of cats) {
        const list = groups.get(cat);
        const indent = cat ? "    " : "  ";
        if (cat) {
            process.stdout.write(`  ${c.bold(cat)} ${c.dim(`(${list.length})`)}\n`);
        }
        for (const info of list) {
            const s = summaryByPath.get(info.path);
            const dot = s.dirty ? c.yellow("●") : c.green("●");
            const upstream = s.hasUpstream && (s.ahead > 0 || s.behind > 0)
                ? `  ${c.cyan(`↑${s.ahead}`)}${c.dim("/")}${c.red(`↓${s.behind}`)}`
                : "";
            const age = s.lastAge ? c.dim(s.lastAge) : "";
            process.stdout.write(`${indent}${dot} ${padPlain(info.name, nameWidth)}  ${padPlain(c.cyan(s.branch), branchWidth)}  ${age}${upstream}\n`);
        }
    }
    if (short) {
        line();
        return 0;
    }
    // ---- active: top-N most recently committed repos ------------------------
    const active = [...summaries]
        .filter((s) => s.lastTs > 0)
        .sort((a, b) => b.lastTs - a.lastTs)
        .slice(0, MAX_DETAIL_REPOS);
    if (active.length > 0) {
        section(`active ${c.dim(`(top ${active.length} by latest commit)`)}`);
        const labelWidth = Math.min(40, Math.max(20, ...active.map((s) => repoLabel(s.info).length)));
        for (const s of active) {
            process.stdout.write(`  ${padPlain(repoLabel(s.info), labelWidth)}  ${c.yellow(s.lastSha.padEnd(8))} ${s.lastMsg} ${c.dim(`(${s.lastAge})`)}\n`);
        }
    }
    // ---- GitHub: issues + PRs (parallel across repos) -----------------------
    if (commandExists("gh") && execSync("gh", ["auth", "status"]).ok) {
        const ghTimeout = Number.parseInt(process.env.CHI_GH_TIMEOUT ?? "3", 10) || 3;
        const candidates = summaries.filter((s) => s.hasGithub).map((s) => s.info);
        const [issueResults, prResults] = await Promise.all([
            Promise.all(candidates.map((info) => fetchGhIssues(ghTimeout, info.path).then((rows) => ({ info, rows: rows ?? [] })))),
            Promise.all(candidates.map((info) => fetchGhPrs(ghTimeout, info.path).then((rows) => ({ info, rows: rows ?? [] })))),
        ]);
        const issueRepos = issueResults.filter((r) => r.rows.length > 0);
        const prRepos = prResults.filter((r) => r.rows.length > 0);
        const totalIssues = issueRepos.reduce((acc, r) => acc + r.rows.length, 0);
        const totalPrs = prRepos.reduce((acc, r) => acc + r.rows.length, 0);
        section(`issues ${c.dim(`(${totalIssues} open · ${issueRepos.length} repos)`)}`);
        if (issueRepos.length === 0) {
            process.stdout.write(`  ${c.dim("(none open)")}\n`);
        }
        else {
            for (const { info, rows } of issueRepos) {
                process.stdout.write(`  ${c.bold(repoLabel(info))}\n`);
                for (const row of rows) {
                    const fm = row.body
                        ? parseFrontmatter(row.body)
                        : { name: "", status: "", progress: "" };
                    const meta = [];
                    if (fm.progress)
                        meta.push(c.dim(`(${fm.progress})`));
                    if (row.labels)
                        meta.push(c.dim(`[${row.labels}]`));
                    if (row.assignees)
                        meta.push(c.dim(`@${row.assignees}`));
                    process.stdout.write(`    ${c.cyan(`#${row.num}`)} ${padPlain(statusBadge(fm.status), 11)} ${row.title}${meta.length ? ` ${meta.join(" ")}` : ""}\n`);
                }
            }
        }
        section(`pull requests ${c.dim(`(${totalPrs} open · ${prRepos.length} repos)`)}`);
        if (prRepos.length === 0) {
            process.stdout.write(`  ${c.dim("(none open)")}\n`);
        }
        else {
            for (const { info, rows } of prRepos) {
                process.stdout.write(`  ${c.bold(repoLabel(info))}\n`);
                for (const row of rows) {
                    const tag = prStateTag(row);
                    process.stdout.write(`    ${c.cyan(`#${row.num}`)} ${padPlain(tag, 9)} ${row.title} ${c.dim(`(${row.head} by @${row.author})`)}\n`);
                }
            }
        }
    }
    line();
    return 0;
}
export async function run(argv) {
    const first = argv[0];
    if (first === "-h" || first === "--help") {
        process.stdout.write(HELP);
        return 0;
    }
    const short = first === "-s" || first === "--short";
    // ---- chi-cli ------------------------------------------------------------
    section(BIN_TAG);
    kv("platform", CHI_OS);
    const provider = getProvider();
    kv("provider", `${activeProviderName()} ${c.dim(`(model: ${provider.activeModel()})`)}`);
    const reachable = await provider.ping();
    kv("reachable", reachable
        ? c.green("yes")
        : `${c.red("no")} ${c.dim(`— run '${BIN_NAME} doctor provider'`)}`);
    const envSet = [];
    for (const v of [
        "CHI_LLM_URL",
        "CHI_LLM_MODEL",
        "BASIC_AUTH_USER",
        "CHI_MAX_DIFF_CHARS",
    ]) {
        const val = process.env[v];
        if (val)
            envSet.push([v, val]);
    }
    if (envSet.length > 0) {
        const f = envSet[0];
        kv("env", `${f[0]}=${f[1]}`);
        for (let i = 1; i < envSet.length; i++) {
            const [k, val] = envSet[i];
            process.stdout.write(`  ${" ".padEnd(18)} ${k}=${val}\n`);
        }
    }
    // ---- git ----------------------------------------------------------------
    if (!isInsideRepo()) {
        return globalStatus(short);
    }
    const root = repoRoot();
    const branch = currentBranch();
    const upstream = upstreamRef();
    const counts = porcelain();
    const dirty = counts.total === 0 ? c.green("clean") : c.yellow("dirty");
    section("git");
    kv("repo", basename(root));
    kv("branch", c.cyan(branch));
    if (upstream) {
        const ab = aheadBehind();
        kv("upstream", `${upstream}  ${c.dim("↑")}${ab.ahead} ${c.dim("↓")}${ab.behind}`);
    }
    kv("state", dirty);
    if (counts.total > 0) {
        kv("changes", `${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked`);
    }
    if (counts.total > 0 && !short) {
        line();
        process.stdout.write(shortStatus());
    }
    // ---- submodules ---------------------------------------------------------
    if (!short && existsSync(join(root, ".gitmodules"))) {
        section("submodules");
        const sm = submoduleStatusRecursive(root);
        if (!sm.trim()) {
            process.stdout.write(`  ${c.dim("(none initialized)")}\n`);
        }
        else {
            for (const ln of sm.split(/\r?\n/)) {
                if (!ln)
                    continue;
                const flag = ln.charAt(0);
                const rest = ln.slice(1);
                switch (flag) {
                    case " ":
                        process.stdout.write(`  ${c.green("✓")} ${rest}\n`);
                        break;
                    case "+":
                        process.stdout.write(`  ${c.yellow("±")} ${rest} ${c.dim("(out of sync)")}\n`);
                        break;
                    case "-":
                        process.stdout.write(`  ${c.red("−")} ${rest} ${c.dim("(not initialized)")}\n`);
                        break;
                    case "U":
                        process.stdout.write(`  ${c.red("!")} ${rest} ${c.dim("(merge conflict)")}\n`);
                        break;
                    default:
                        process.stdout.write(`  ${ln}\n`);
                }
            }
        }
    }
    // ---- recent commits -----------------------------------------------------
    if (!short) {
        section("recent commits");
        process.stdout.write(recentCommits(5));
        line();
    }
    // ---- GitHub: issues + pull requests -------------------------------------
    if (!short && commandExists("gh") && execSync("gh", ["auth", "status"]).ok) {
        const ghTimeout = Number.parseInt(process.env.CHI_GH_TIMEOUT ?? "3", 10) || 3;
        const [issues, prs] = await Promise.all([
            fetchGhIssues(ghTimeout),
            fetchGhPrs(ghTimeout),
        ]);
        section("issues");
        if (issues && issues.length > 0) {
            for (const row of issues) {
                const fm = row.body
                    ? parseFrontmatter(row.body)
                    : { name: "", status: "", progress: "" };
                const meta = [];
                if (fm.progress)
                    meta.push(c.dim(`(${fm.progress})`));
                if (row.labels)
                    meta.push(c.dim(`[${row.labels}]`));
                if (row.assignees)
                    meta.push(c.dim(`@${row.assignees}`));
                process.stdout.write(`  ${c.cyan(`#${row.num}`)} ${statusBadge(fm.status).padEnd(11)} ${row.title}${meta.length ? ` ${meta.join(" ")}` : ""}\n`);
            }
        }
        else {
            process.stdout.write(`  ${c.dim("(none open)")}\n`);
        }
        section("pull requests");
        if (prs && prs.length > 0) {
            for (const row of prs) {
                const tag = prStateTag(row);
                process.stdout.write(`  ${c.cyan(`#${row.num}`)} ${tag.padEnd(9)} ${row.title} ${c.dim(`(${row.head} by @${row.author})`)}\n`);
            }
        }
        else {
            process.stdout.write(`  ${c.dim("(none open)")}\n`);
        }
    }
    // ---- plans --------------------------------------------------------------
    if (!short) {
        const plansDir = join(root, ".chi", "plans");
        const altDir = join(root, ".che", "plans");
        let dirToUse = "";
        if (existsSync(plansDir) && statSync(plansDir).isDirectory())
            dirToUse = plansDir;
        else if (existsSync(altDir) && statSync(altDir).isDirectory())
            dirToUse = altDir;
        if (dirToUse) {
            const entries = readdirSync(dirToUse).filter((e) => e.endsWith(".md") && e !== "README.md");
            if (entries.length > 0) {
                section("plans");
                for (const entry of entries) {
                    const file = join(dirToUse, entry);
                    const fm = parseFrontmatterFile(file);
                    const stem = entry.replace(/\.md$/, "");
                    const name = fm.name || stem;
                    const badge = statusBadge(fm.status);
                    const extra = fm.progress ? ` ${c.dim(`(${fm.progress})`)}` : "";
                    process.stdout.write(`  ${badge.padEnd(11)} ${name}${extra} ${c.dim(`(${entry})`)}\n`);
                }
            }
            else if (process.env.CHI_STATUS_SHOW_EMPTY === "1") {
                section("plans");
                process.stdout.write(`  ${c.dim(`(no plans in ${dirToUse})`)}\n`);
            }
        }
    }
    line();
    return 0;
}
//# sourceMappingURL=status.js.map