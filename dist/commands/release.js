import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists } from "../spawn.js";
import { git, isInsideRepo, repoRoot, currentBranch, porcelain, upstreamRef } from "../git/index.js";
import { BIN_NAME } from "../identity.js";
import { c } from "../ui.js";
const HELP = `${BIN_NAME} release — create and push an annotated git tag.

Usage:
  ${BIN_NAME} release [version]      create vX.Y.Z tag and push to origin

If [version] is omitted, the version field of ./package.json is used (when
present). A leading 'v' is added automatically. The tag is annotated with the
version string (override with --message). After pushing, a configured CI
workflow (e.g. on: push: tags: ['v*']) can publish a GitHub Release.

Options:
  -m, --message <msg>   annotation message (default: the version, e.g. v0.2.0)
      --no-push         create the tag locally only; don't push
      --remote <name>   remote to push to (default: origin)
  -h, --help            show this help
`;
function parseArgs(argv) {
    const out = { version: null, message: null, push: true, remote: "origin" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "-h" || a === "--help")
            return { error: "__help__" };
        if (a === "-m" || a === "--message") {
            const v = argv[++i];
            if (!v)
                return { error: `${a} needs a value` };
            out.message = v;
            continue;
        }
        if (a === "--no-push") {
            out.push = false;
            continue;
        }
        if (a === "--remote") {
            const v = argv[++i];
            if (!v)
                return { error: `--remote needs a value` };
            out.remote = v;
            continue;
        }
        if (a.startsWith("-"))
            return { error: `unknown option '${a}'` };
        if (out.version !== null)
            return { error: `unexpected argument '${a}'` };
        out.version = a;
    }
    return out;
}
function readPackageVersion(root) {
    const path = join(root, "package.json");
    if (!existsSync(path))
        return null;
    try {
        const json = JSON.parse(readFileSync(path, "utf8"));
        return typeof json.version === "string" && json.version.length > 0 ? json.version : null;
    }
    catch {
        return null;
    }
}
function normalizeTag(input) {
    const stripped = input.startsWith("v") || input.startsWith("V") ? input.slice(1) : input;
    // semver-ish: X.Y.Z with optional -prerelease and +build
    if (!/^\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]+)?$/.test(stripped))
        return null;
    return `v${stripped}`;
}
export async function run(argv) {
    const parsed = parseArgs(argv);
    if ("error" in parsed) {
        if (parsed.error === "__help__") {
            process.stdout.write(HELP);
            return 0;
        }
        process.stderr.write(`${BIN_NAME} release: ${parsed.error}\n`);
        return 1;
    }
    if (!commandExists("git")) {
        process.stderr.write(`${BIN_NAME} release: missing dependency: git\n`);
        return 1;
    }
    if (!isInsideRepo()) {
        process.stderr.write(`${BIN_NAME} release: not a git repository\n`);
        return 1;
    }
    const root = repoRoot();
    const versionArg = parsed.version ?? readPackageVersion(root);
    if (!versionArg) {
        process.stderr.write(`${BIN_NAME} release: no version supplied and no package.json/version found\n` +
            `usage: ${BIN_NAME} release <version>\n`);
        return 1;
    }
    const tag = normalizeTag(versionArg);
    if (!tag) {
        process.stderr.write(`${BIN_NAME} release: '${versionArg}' is not a valid semver version (expected X.Y.Z)\n`);
        return 1;
    }
    const exists = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).ok;
    if (exists) {
        process.stderr.write(`${BIN_NAME} release: tag ${tag} already exists\n`);
        return 1;
    }
    const counts = porcelain();
    if (counts.total > 0) {
        process.stderr.write(`${BIN_NAME} release: working tree has uncommitted changes ` +
            `(${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked)\n` +
            `commit or stash them before tagging\n`);
        return 1;
    }
    const branch = currentBranch();
    const message = parsed.message ?? tag;
    const tagRes = git(["tag", "-a", tag, "-m", message]);
    if (!tagRes.ok) {
        process.stderr.write(tagRes.stderr || `failed to create tag ${tag}\n`);
        return tagRes.status ?? 1;
    }
    process.stdout.write(`${c.green("✓")} created annotated tag ${c.cyan(tag)} on ${branch}\n`);
    if (!parsed.push) {
        process.stdout.write(`note: --no-push given, push later with: git push ${parsed.remote} ${tag}\n`);
        return 0;
    }
    if (!upstreamRef()) {
        process.stderr.write(`${BIN_NAME} release: branch '${branch}' has no upstream — pushing tag to '${parsed.remote}' anyway\n`);
    }
    const pushRes = git(["push", parsed.remote, tag]);
    process.stdout.write(pushRes.stdout);
    if (!pushRes.ok) {
        process.stderr.write(pushRes.stderr);
        process.stderr.write(`\n${c.red(`${BIN_NAME} release: tag created locally but push to ${parsed.remote} failed`)}\n` +
            `retry with: git push ${parsed.remote} ${tag}\n` +
            `or remove the local tag: git tag -d ${tag}\n`);
        return pushRes.status ?? 1;
    }
    process.stdout.write(`${c.green("✓")} pushed ${c.cyan(tag)} to ${parsed.remote}\n`);
    return 0;
}
//# sourceMappingURL=release.js.map