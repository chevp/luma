import { commandExists, execInherit } from "../spawn.js";
import { git, isInsideRepo, repoRoot, currentBranch, porcelain, upstreamRef } from "../git/index.js";
import { BIN_NAME } from "../identity.js";
import { c, sym } from "../ui.js";
import { confirmYesNo } from "../prompt.js";
import { nextSemver } from "../version-bump.js";
import { deterministicChecks, lastTag, levelBetween, llmReview, releaseSkill } from "../release/check.js";
import { listVersionFiles, primaryVersion, syncCargoLock, writeVersions } from "../release/versions.js";
const HELP = `${BIN_NAME} release — bump versions, check plausibility, commit, tag, push, optionally publish.

Usage:
  ${BIN_NAME} release                     let the LLM pick patch/minor/major (fallback: patch)
  ${BIN_NAME} release patch|minor|major   bump that level
  ${BIN_NAME} release X.Y.Z               set exactly that version
  ${BIN_NAME} release --no-bump           tag the version the files already carry

Version files: every tracked package.json, Cargo.toml ([package] / [workspace.package])
and tauri.conf.json at the shared version is bumped together; files at another
version are reported and left alone. Cargo.lock is kept in step.

Checks before anything is written:
  - the version is semver, higher than the last tag, and without gaps
  - there are commits since the last tag
  - the local LLM (ollama, or the configured provider) judges the level from the
    commits and diff since the last tag, using the repo's own
    .claude/skills/*release*/SKILL.md when present; a mismatch asks for confirmation

Options:
  -m, --message <msg>   tag annotation message (default: the tag)
      --no-bump         skip the version bump
      --no-push         do everything locally; don't push commit or tag
      --no-llm          skip the LLM check (deterministic checks still run)
      --gh-release      after the push, create the GitHub Release with gh
      --asset <path>    file attached to the GitHub Release (repeatable)
      --draft           create the GitHub Release as draft
      --dry-run         run the checks and print the plan, write nothing
  -y, --yes             don't ask for confirmation
      --remote <name>   remote to push to (default: origin)
  -h, --help            show this help
`;
const FLAGS = {
    "--no-bump": (a) => { a.noBump = true; },
    "--no-push": (a) => { a.push = false; },
    "--no-llm": (a) => { a.noLlm = true; },
    "--gh-release": (a) => { a.ghRelease = true; },
    "--draft": (a) => { a.draft = true; },
    "--dry-run": (a) => { a.dry = true; },
    "--dry": (a) => { a.dry = true; },
    "-y": (a) => { a.yes = true; },
    "--yes": (a) => { a.yes = true; },
};
function parseArgs(argv) {
    const out = {
        version: null, level: null, noBump: false, noLlm: false, dry: false, yes: false,
        ghRelease: false, draft: false, assets: [], message: null, push: true, remote: "origin",
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "-h" || a === "--help")
            return { error: "__help__" };
        const flag = FLAGS[a];
        if (flag) {
            flag(out);
            continue;
        }
        if (a === "-m" || a === "--message" || a === "--asset" || a === "--remote") {
            const v = argv[++i];
            if (!v)
                return { error: `${a} needs a value` };
            if (a === "--asset")
                out.assets.push(v);
            else if (a === "--remote")
                out.remote = v;
            else
                out.message = v;
            continue;
        }
        if (a.startsWith("-"))
            return { error: `unknown option '${a}'` };
        if (out.version !== null || out.level !== null)
            return { error: `unexpected argument '${a}'` };
        if (a === "patch" || a === "minor" || a === "major")
            out.level = a;
        else
            out.version = a.replace(/^v/i, "");
    }
    return out;
}
function fail(msg) {
    process.stderr.write(`${BIN_NAME} release: ${msg}\n`);
    return 1;
}
export async function run(argv) {
    const args = parseArgs(argv);
    if ("error" in args) {
        if (args.error === "__help__") {
            process.stdout.write(HELP);
            return 0;
        }
        return fail(args.error);
    }
    if (!commandExists("git"))
        return fail("missing dependency: git");
    if (!isInsideRepo())
        return fail("not a git repository");
    if (args.ghRelease && !commandExists("gh"))
        return fail("--gh-release needs the gh CLI");
    const root = repoRoot();
    const files = listVersionFiles(root);
    const primary = primaryVersion(files);
    const previousTag = lastTag(root);
    const skill = releaseSkill(root);
    const sinceTag = previousTag ? Number.parseInt(git(["rev-list", "--count", `${previousTag}..HEAD`], root).stdout.trim(), 10) : null;
    if (!primary && !args.version) {
        return fail(`no version in package.json/Cargo.toml/tauri.conf.json — supply one (${BIN_NAME} release X.Y.Z)`);
    }
    // In auto mode the LLM's level is the choice; for what the user chose it only reviews.
    let target;
    let level = args.level;
    let llmNote = "";
    if (args.version) {
        target = args.version;
    }
    else if (args.noBump) {
        target = primary;
    }
    else {
        if (!level) {
            const auto = args.noLlm ? null : await llmReview(root, previousTag, null, skill);
            level = auto?.level ?? "patch";
            if (auto && level === "major" && primary?.startsWith("0."))
                level = "minor";
            llmNote = auto ? `${level} — ${auto.reason}` : "";
            if (!auto)
                process.stdout.write(`${sym.warn} no LLM answer, defaulting to patch\n`);
        }
        const next = nextSemver(primary, level);
        if (!next)
            return fail(`current version '${primary}' is not parseable semver`);
        target = next;
    }
    const tag = `v${target}`;
    const checks = deterministicChecks({ target, previousTag, files, primary, commitsSinceTag: sinceTag });
    const chosenLevel = primary ? levelBetween(primary, target) : null;
    let mismatch = false;
    if (!args.noLlm && !llmNote && chosenLevel && !args.noBump) {
        const review = await llmReview(root, previousTag, target, skill);
        if (review && review.level !== chosenLevel) {
            mismatch = true;
            checks.warnings.push(`LLM suggests ${review.level} instead of ${chosenLevel}: ${review.reason}`);
        }
        else if (review) {
            process.stdout.write(`${sym.ok} LLM agrees with ${chosenLevel}${review.reason ? c.dim(` — ${review.reason}`) : ""}\n`);
        }
        else {
            process.stdout.write(`${sym.warn} ${c.dim("LLM check unavailable, skipped")}\n`);
        }
    }
    if (llmNote)
        process.stdout.write(`${sym.ok} LLM level: ${llmNote}\n`);
    for (const w of checks.warnings)
        process.stdout.write(`${sym.warn} ${c.yellow(w)}\n`);
    for (const e of checks.errors)
        process.stdout.write(`${sym.err} ${c.red(e)}\n`);
    if (checks.errors.length)
        return 1;
    if (git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).ok)
        return fail(`tag ${tag} already exists`);
    const counts = porcelain();
    if (counts.total > 0) {
        return fail(`working tree has uncommitted changes (${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked)\ncommit or stash them before tagging`);
    }
    const branch = currentBranch();
    const bumpFrom = args.noBump ? null : primary;
    const toWrite = bumpFrom !== null && bumpFrom !== target ? files.filter((f) => f.version === bumpFrom).map((f) => f.path) : [];
    process.stdout.write(`\n${c.bold(`release ${previousTag ?? "(first)"} → ${tag}`)} on ${branch}\n` +
        (toWrite.length ? `  bump  ${toWrite.join(", ")}\n` : "") +
        `  tag   ${tag}${args.push ? `, push to ${args.remote}` : " (local only)"}${args.ghRelease ? ", GitHub Release" : ""}\n`);
    if (args.dry) {
        process.stdout.write(`${c.yellow("[DRY]")} nothing written\n`);
        return 0;
    }
    if ((mismatch || checks.warnings.length) && !args.yes && !(await confirmYesNo("Continue? [Y/n] "))) {
        process.stdout.write("aborted\n");
        return 1;
    }
    if (toWrite.length && bumpFrom !== null) {
        const res = writeVersions(root, files, bumpFrom, target);
        const lock = syncCargoLock(root);
        const add = git(["add", "--", ...res.changed, ...(lock ? ["Cargo.lock"] : [])], root);
        if (!add.ok)
            return fail(add.stderr || "failed to stage version files");
        const commit = git(["commit", "-m", `release ${tag}`], root);
        if (!commit.ok)
            return fail(commit.stderr || "failed to commit version bump");
        process.stdout.write(`${sym.ok} bumped ${res.changed.join(", ")} ${c.dim(`${bumpFrom} →`)} ${c.green(target)}\n`);
    }
    const tagRes = git(["tag", "-a", tag, "-m", args.message ?? tag]);
    if (!tagRes.ok)
        return fail(tagRes.stderr || `failed to create tag ${tag}`);
    process.stdout.write(`${sym.ok} created annotated tag ${c.cyan(tag)} on ${branch}\n`);
    if (!args.push) {
        process.stdout.write(`note: --no-push given, push later with: git push ${args.remote} ${branch} && git push ${args.remote} ${tag}\n`);
        return 0;
    }
    // Commit first, so the tag never points at a commit the remote lacks.
    if (toWrite.length && upstreamRef()) {
        const pushBranch = git(["push", args.remote, branch]);
        process.stdout.write(pushBranch.stdout);
        if (!pushBranch.ok) {
            process.stderr.write(pushBranch.stderr);
            return fail(`bump commit created locally but push failed\nretry with: git push ${args.remote} ${branch} && git push ${args.remote} ${tag}`);
        }
        process.stdout.write(`${sym.ok} pushed ${c.cyan(branch)} to ${args.remote}\n`);
    }
    const pushTag = git(["push", args.remote, tag]);
    process.stdout.write(pushTag.stdout);
    if (!pushTag.ok) {
        process.stderr.write(pushTag.stderr);
        return fail(`tag created locally but push failed\nretry with: git push ${args.remote} ${tag}\nor remove the local tag: git tag -d ${tag}`);
    }
    process.stdout.write(`${sym.ok} pushed ${c.cyan(tag)} to ${args.remote}\n`);
    if (!args.ghRelease)
        return 0;
    const title = `${root.split(/[\\/]/).pop()} ${tag}`;
    const code = await execInherit("gh", ["release", "create", tag, ...args.assets, "--title", title, "--generate-notes", ...(args.draft ? ["--draft"] : [])], { cwd: root });
    if (code !== 0)
        return fail(`gh release create failed (exit ${code}); tag ${tag} is already pushed`);
    return 0;
}
//# sourceMappingURL=release.js.map