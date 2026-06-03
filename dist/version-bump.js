import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { git } from "./git/index.js";
import { c, sym } from "./ui.js";
import { BIN_NAME } from "./identity.js";
import { activeProviderName, getProvider, providerEnsureRunning, providerSmartGenerate, } from "./provider/index.js";
import { withSpinner } from "./spinner.js";
import { isDry, dryNote } from "./dry.js";
/** Increment a semver string by the given level. Returns null if unparseable. */
export function nextSemver(version, level) {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
    if (!m)
        return null;
    const major = Number.parseInt(m[1] ?? "0", 10);
    const minor = Number.parseInt(m[2] ?? "0", 10);
    const patch = Number.parseInt(m[3] ?? "0", 10);
    const suffix = m[4] ?? "";
    if (level === "major")
        return `${major + 1}.0.0${suffix}`;
    if (level === "minor")
        return `${major}.${minor + 1}.0${suffix}`;
    return `${major}.${minor}.${patch + 1}${suffix}`;
}
/**
 * Ask the active LLM provider whether the pending diff warrants a patch,
 * minor, or major bump. Falls back to "patch" if the provider is unreachable,
 * returns garbage, or the diff is empty.
 *
 * Diff source is `git diff HEAD` — captures all tracked-file changes in the
 * worktree, which is what's about to be committed by ship.
 */
async function decideBumpLevel(repoRoot) {
    const fallback = "patch";
    const diffRes = git(["-C", repoRoot, "diff", "HEAD", "--no-color"]);
    const diff = diffRes.stdout;
    if (!diff.trim())
        return fallback;
    const max = Number.parseInt(process.env.LUMA_MAX_DIFF_CHARS ?? process.env.CHI_MAX_DIFF_CHARS ?? "6000", 10) || 6000;
    const trimmed = diff.length > max ? `${diff.slice(0, max)}\n\n[diff truncated at ${max} chars]` : diff;
    const prompt = `You are choosing a semantic-version bump level for the following diff.\n` +
        `Reply with EXACTLY ONE word, no punctuation, no explanation: patch, minor, or major.\n\n` +
        `Rules:\n` +
        `  - patch: bug fixes, internal refactors, docs, tests, build/CI tweaks, dependency bumps\n` +
        `  - minor: new user-visible features, new public APIs, backward-compatible additions\n` +
        `  - major: breaking changes to public API/CLI/config, removed features, behavior changes that require user action\n\n` +
        `Diff:\n${trimmed}\n`;
    try {
        await providerEnsureRunning().catch(() => false);
        const provider = getProvider();
        const raw = await withSpinner(`choosing version bump via ${activeProviderName()} (${provider.activeModel()})`, () => providerSmartGenerate(prompt));
        const word = raw.trim().toLowerCase().match(/\b(major|minor|patch)\b/)?.[1];
        if (word === "major" || word === "minor" || word === "patch")
            return word;
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} LLM returned unrecognized bump level, ${c.yellow("defaulting to patch")}\n`);
    }
    catch (err) {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} ${c.yellow("bump-level inference failed")} ${c.dim(`(${err instanceof Error ? err.message : String(err)})`)} — ${c.yellow("defaulting to patch")}\n`);
    }
    return fallback;
}
/** Bump <repoRoot>/package.json's `version` field. Returns new version or null. */
function bumpPackageJson(repoRoot, level) {
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
    const oldVersion = pkg.version;
    const next = nextSemver(oldVersion, level);
    if (!next) {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} version '${oldVersion}' is not parseable semver, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    const indentMatch = /\n([ \t]+)"/.exec(raw);
    const indent = indentMatch?.[1] ?? "  ";
    const trailingNewline = raw.endsWith("\n") ? "\n" : "";
    pkg.version = next;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + trailingNewline);
    process.stdout.write(`${sym.arrow} ${c.dim(`${BIN_NAME} ship:`)} bumped ${c.cyan("package.json")} ${c.dim(oldVersion + " →")} ${c.green(next)} ${c.dim(`(${level})`)}\n`);
    return next;
}
/**
 * Bump the VERSION argument of the top-level `project(... VERSION X.Y.Z ...)`
 * call in <repoRoot>/CMakeLists.txt. Returns new version or null when the file
 * is missing, has no parseable VERSION, or the current value is non-semver.
 */
function bumpCMakeLists(repoRoot, level) {
    const cmPath = join(repoRoot, "CMakeLists.txt");
    if (!existsSync(cmPath))
        return null;
    let raw;
    try {
        raw = readFileSync(cmPath, "utf8");
    }
    catch {
        return null;
    }
    // Match project(... VERSION X.Y.Z[.W][suffix] ...) — case-insensitive, multi-line.
    const projRe = /\b(project\s*\([^)]*?\bVERSION\s+)(\d+\.\d+\.\d+)([^\s)]*)/is;
    const m = projRe.exec(raw);
    if (!m) {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} CMakeLists.txt has no project(VERSION ...) directive, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    const oldVersion = m[2] ?? "";
    const next = nextSemver(oldVersion, level);
    if (!next) {
        process.stdout.write(`${sym.warn} ${c.dim(`${BIN_NAME} ship:`)} CMake version '${oldVersion}' is not parseable semver, ${c.yellow("skipping bump")}\n`);
        return null;
    }
    const newContent = raw.replace(projRe, (_full, prefix, _ver, tail) => `${prefix}${next}${tail}`);
    writeFileSync(cmPath, newContent);
    process.stdout.write(`${sym.arrow} ${c.dim(`${BIN_NAME} ship:`)} bumped ${c.cyan("CMakeLists.txt")} ${c.dim(oldVersion + " →")} ${c.green(next)} ${c.dim(`(${level})`)}\n`);
    return next;
}
/**
 * Bump version metadata in known files (package.json, CMakeLists.txt) before
 * the next commit. Uses the LLM to choose patch/minor/major from the worktree
 * diff; falls back to patch when the provider is unreachable.
 *
 * No-op when neither file exists. Only callers that have already verified the
 * working tree is dirty AND that the call is top-level
 * (process.env.__CHI_NESTED !== "1") should invoke this.
 */
export async function maybeBumpVersions(repoRoot) {
    const hasPkg = existsSync(join(repoRoot, "package.json"));
    const hasCMake = existsSync(join(repoRoot, "CMakeLists.txt"));
    if (!hasPkg && !hasCMake)
        return;
    const level = await decideBumpLevel(repoRoot);
    if (isDry()) {
        const files = [hasPkg ? "package.json" : "", hasCMake ? "CMakeLists.txt" : ""]
            .filter(Boolean)
            .join(", ");
        dryNote(`would bump ${c.cyan(files)} (${c.green(level)})`);
        return;
    }
    if (hasPkg)
        bumpPackageJson(repoRoot, level);
    if (hasCMake)
        bumpCMakeLists(repoRoot, level);
}
//# sourceMappingURL=version-bump.js.map