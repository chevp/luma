import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git/index.js";
import { activeProviderName, getProvider, providerEnsureRunning, providerSmartGenerate } from "../provider/index.js";
import { withSpinner } from "../spinner.js";
import { nextSemver } from "../version-bump.js";
export function parseSemver(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m)
        return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}
export function compareSemver(a, b) {
    const x = parseSemver(a);
    const y = parseSemver(b);
    if (!x || !y)
        return 0;
    for (const k of ["major", "minor", "patch"]) {
        if (x[k] !== y[k])
            return x[k] < y[k] ? -1 : 1;
    }
    if (x.pre === y.pre)
        return 0;
    if (x.pre === "")
        return 1;
    if (y.pre === "")
        return -1;
    return x.pre < y.pre ? -1 : 1;
}
/** Which component `to` raised relative to `from`; null when it is not higher. */
export function levelBetween(from, to) {
    const a = parseSemver(from);
    const b = parseSemver(to);
    if (!a || !b || compareSemver(from, to) >= 0)
        return null;
    if (b.major > a.major)
        return "major";
    if (b.minor > a.minor)
        return "minor";
    return "patch";
}
/** Latest reachable `vX.Y.Z` tag, or null. */
export function lastTag(cwd) {
    const r = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], cwd);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}
/** Rules that need no LLM: monotonic, gap-free, in sync, something to release. */
export function deterministicChecks(input) {
    const errors = [];
    const warnings = [];
    const { target, previousTag, files, primary, commitsSinceTag } = input;
    const prevVersion = previousTag?.replace(/^v/, "") ?? null;
    if (!parseSemver(target))
        errors.push(`'${target}' is not valid semver (X.Y.Z[-pre])`);
    if (prevVersion) {
        if (compareSemver(target, prevVersion) <= 0) {
            errors.push(`${target} is not higher than the last tag ${previousTag}`);
        }
        else if (!parseSemver(target)?.pre) {
            const consecutive = ["patch", "minor", "major"].some((l) => nextSemver(prevVersion, l) === target);
            if (!consecutive)
                warnings.push(`${target} skips versions after ${previousTag} (expected ${nextSemver(prevVersion, "patch")}, ${nextSemver(prevVersion, "minor")} or ${nextSemver(prevVersion, "major")})`);
        }
        if (commitsSinceTag === 0)
            errors.push(`no commits since ${previousTag} — nothing to release`);
    }
    if (prevVersion && primary && compareSemver(primary, prevVersion) !== 0) {
        warnings.push(`version files say ${primary}, last tag is ${previousTag}`);
    }
    for (const f of files) {
        if (primary && f.version !== primary)
            warnings.push(`${f.path} is at ${f.version}, not ${primary} — left unchanged`);
    }
    return { errors, warnings };
}
const SKILL_LIMIT = 4000;
/** `.claude/skills/<*release*>/SKILL.md` of the repo, so the LLM judges by that repo's own rules. */
export function releaseSkill(root) {
    const dir = join(root, ".claude", "skills");
    if (!existsSync(dir))
        return null;
    for (const name of readdirSync(dir)) {
        if (!/release/i.test(name))
            continue;
        const file = join(dir, name, "SKILL.md");
        if (existsSync(file))
            return readFileSync(file, "utf8").slice(0, SKILL_LIMIT);
    }
    return null;
}
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} chars]` : text;
}
/** Asks the active provider which bump the changes since the last tag warrant; null when unavailable. */
export async function llmReview(root, previousTag, proposed, skill) {
    const range = previousTag ? [`${previousTag}..HEAD`] : [];
    const log = git(["log", "--pretty=format:%s", "-n", "60", ...range], root).stdout.trim();
    const stat = git(["diff", "--stat", ...(previousTag ? [previousTag, "HEAD"] : ["HEAD~1", "HEAD"])], root).stdout.trim();
    const max = Number.parseInt(process.env.LUMA_MAX_DIFF_CHARS ?? "6000", 10) || 6000;
    const diff = truncate(git(["diff", "--no-color", ...(previousTag ? [previousTag, "HEAD"] : ["HEAD~1", "HEAD"])], root).stdout, max);
    if (!log && !diff.trim())
        return null;
    const prompt = `You review the version number of a planned software release.\n` +
        `Previous release: ${previousTag ?? "none"}\n` +
        `Proposed version: ${proposed ?? "(none — choose the bump level)"}\n\n` +
        `Rules (semantic versioning):\n` +
        `  - patch: bug fixes, refactors, docs, tests, CI/build tweaks, dependency bumps\n` +
        `  - minor: new user-visible features, backward-compatible additions\n` +
        `  - major: breaking changes to public API/CLI/config or removed features\n` +
        `  - while the major version is 0: breaking changes and new features are minor; fixes are patch; major only declares 1.0\n` +
        (skill ? `\nRepo release rules:\n${skill}\n` : "") +
        `\nCommits since the last release:\n${log || "(none)"}\n\nDiff stat:\n${stat}\n\nDiff:\n${diff}\n\n` +
        `Reply with exactly two lines:\nLEVEL: patch|minor|major\nREASON: <one short sentence>\n`;
    try {
        if (!(await providerEnsureRunning().catch(() => false)))
            return null;
        const provider = getProvider();
        const raw = await withSpinner(`checking version plausibility via ${activeProviderName()} (${provider.activeModel()})`, () => providerSmartGenerate(prompt));
        const level = /LEVEL:\s*(patch|minor|major)/i.exec(raw)?.[1]?.toLowerCase();
        if (level !== "patch" && level !== "minor" && level !== "major")
            return null;
        return { level, reason: /REASON:\s*(.+)/i.exec(raw)?.[1]?.trim() ?? "" };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=check.js.map