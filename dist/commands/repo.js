import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "../spawn.js";
import { c, sym } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import { readLine } from "../prompt.js";
const HELP = `${BIN_NAME} repo — diagnose and fix common repo hygiene issues.

Usage: ${BIN_NAME} repo [options]

Checks (run against the current git repo):
  - missing .gitignore at repo root
  - tracked build artifacts (target/, .gradle/, build/, node_modules/, *.class, ...)
  - broken submodule references (gitlinks without a .gitmodules entry)

Options:
  --fix        apply fixes interactively (generate .gitignore, untrack artifacts)
  --yes        skip confirmation prompts (use with --fix)
  -h, --help   show this help
`;
function ok(msg) {
    process.stdout.write(`  ${sym.ok} ${msg}\n`);
}
function fail(msg) {
    process.stdout.write(`  ${sym.err} ${c.red("error:")} ${msg}\n`);
}
function warn(msg) {
    process.stdout.write(`  ${sym.warn} ${c.yellow("warn:")} ${msg}\n`);
}
function info(msg) {
    process.stdout.write(`    ${c.dim(msg)}\n`);
}
function findRepoRoot() {
    const r = execSync("git", ["rev-parse", "--show-toplevel"]);
    if (!r.ok)
        return null;
    return r.stdout.trim();
}
function gitLsFiles(root) {
    const r = execSync("git", ["-C", root, "ls-files"]);
    if (!r.ok)
        return [];
    return r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
}
function gitLsFilesWithMode(root) {
    const r = execSync("git", ["-C", root, "ls-files", "-s"]);
    if (!r.ok)
        return [];
    const out = [];
    for (const ln of r.stdout.split(/\r?\n/)) {
        if (!ln)
            continue;
        // Format: <mode> <object> <stage>\t<path>
        const m = ln.match(/^(\d{6})\s+\S+\s+\d+\t(.+)$/);
        if (m && m[1] && m[2])
            out.push({ mode: m[1], path: m[2] });
    }
    return out;
}
function detectStack(tracked) {
    const stack = {
        maven: false,
        gradle: false,
        node: false,
        python: false,
        android: false,
        ide: true,
        os: true,
    };
    for (const p of tracked) {
        const name = p.split("/").pop() ?? "";
        if (name === "pom.xml")
            stack.maven = true;
        else if (name === "build.gradle" ||
            name === "build.gradle.kts" ||
            name === "settings.gradle" ||
            name === "settings.gradle.kts" ||
            name === "gradlew")
            stack.gradle = true;
        else if (name === "package.json" && !p.includes("node_modules/"))
            stack.node = true;
        else if (name === "pyproject.toml" || name === "setup.py" || name === "requirements.txt")
            stack.python = true;
        else if (name === "AndroidManifest.xml" || name === "local.properties")
            stack.android = true;
    }
    if (stack.android)
        stack.gradle = true;
    return stack;
}
const PATTERNS_MAVEN = ["target/", "*.class", "*.jar", "*.war", "dependency-reduced-pom.xml"];
const PATTERNS_GRADLE = [".gradle/", "build/", "!gradle/wrapper/gradle-wrapper.jar"];
const PATTERNS_NODE = ["node_modules/", "dist/", "*.log", ".env"];
const PATTERNS_PYTHON = ["__pycache__/", "*.pyc", ".pytest_cache/", ".venv/", "*.egg-info/"];
const PATTERNS_ANDROID = ["local.properties", ".cxx/", "captures/", "*.apk", "*.aab"];
const PATTERNS_IDE = [".idea/", "*.iml", ".vscode/", ".project", ".classpath", ".settings/"];
const PATTERNS_OS = [".DS_Store", "Thumbs.db", "desktop.ini"];
function buildGitignore(stack) {
    const sections = [];
    if (stack.maven)
        sections.push(["# --- Maven ---", ...PATTERNS_MAVEN]);
    if (stack.gradle)
        sections.push(["# --- Gradle ---", ...PATTERNS_GRADLE]);
    if (stack.android)
        sections.push(["# --- Android ---", ...PATTERNS_ANDROID]);
    if (stack.node)
        sections.push(["# --- Node ---", ...PATTERNS_NODE]);
    if (stack.python)
        sections.push(["# --- Python ---", ...PATTERNS_PYTHON]);
    sections.push(["# --- IDE ---", ...PATTERNS_IDE]);
    sections.push(["# --- OS ---", ...PATTERNS_OS]);
    return sections.map((s) => s.join("\n")).join("\n\n") + "\n";
}
function expectedPatternsFor(stack) {
    const out = [];
    if (stack.maven)
        out.push(...PATTERNS_MAVEN);
    if (stack.gradle)
        out.push(...PATTERNS_GRADLE);
    if (stack.android)
        out.push(...PATTERNS_ANDROID);
    if (stack.node)
        out.push(...PATTERNS_NODE);
    if (stack.python)
        out.push(...PATTERNS_PYTHON);
    return out.filter((p) => !p.startsWith("!"));
}
// Build-output paths that should never be tracked, regardless of stack.
const ARTIFACT_RULES = [
    { name: ".gradle/", test: (p) => /(^|\/)\.gradle\//.test(p) },
    { name: "target/", test: (p) => /(^|\/)target\//.test(p) },
    { name: "build/", test: (p) => /(^|\/)build\//.test(p) && !/gradle\/wrapper/.test(p) },
    { name: "node_modules/", test: (p) => /(^|\/)node_modules\//.test(p) },
    { name: "dist/", test: (p) => /(^|\/)dist\//.test(p) },
    { name: "*.class", test: (p) => p.endsWith(".class") },
    { name: "__pycache__/", test: (p) => /(^|\/)__pycache__\//.test(p) },
    { name: ".idea/", test: (p) => /(^|\/)\.idea\//.test(p) },
    { name: ".DS_Store", test: (p) => p.endsWith("/.DS_Store") || p === ".DS_Store" },
];
function findTrackedArtifacts(tracked) {
    const buckets = new Map();
    for (const p of tracked) {
        for (const r of ARTIFACT_RULES) {
            if (r.test(p)) {
                if (!buckets.has(r.name))
                    buckets.set(r.name, []);
                buckets.get(r.name).push(p);
                break;
            }
        }
    }
    return [...buckets.entries()].map(([rule, paths]) => ({ rule, paths }));
}
function parseGitmodulesPaths(content) {
    const paths = new Set();
    for (const ln of content.split(/\r?\n/)) {
        const m = ln.match(/^\s*path\s*=\s*(.+?)\s*$/);
        if (m && m[1])
            paths.add(m[1]);
    }
    return paths;
}
function findBrokenGitlinks(root) {
    const entries = gitLsFilesWithMode(root).filter((e) => e.mode === "160000");
    if (entries.length === 0)
        return [];
    const gmPath = join(root, ".gitmodules");
    const declared = existsSync(gmPath) ? parseGitmodulesPaths(readFileSync(gmPath, "utf8")) : new Set();
    return entries.filter((e) => !declared.has(e.path)).map((e) => e.path);
}
async function confirm(question, autoYes) {
    if (autoYes)
        return true;
    if (!process.stdin.isTTY) {
        info("not a TTY — skipping (use --yes to auto-confirm)");
        return false;
    }
    const ans = await readLine(`${question} [y/N] `);
    return ans?.trim().toLowerCase() === "y";
}
function mergeGitignore(existing, stack) {
    const lines = existing.split(/\r?\n/);
    const present = new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
    const needed = expectedPatternsFor(stack);
    const added = needed.filter((p) => !present.has(p));
    if (added.length === 0)
        return { merged: existing, added: [] };
    const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    const block = "\n# --- added by luma repo --fix ---\n" + added.join("\n") + "\n";
    return { merged: existing + prefix + block, added };
}
export async function run(argv) {
    const flags = new Set(argv);
    if (flags.has("-h") || flags.has("--help")) {
        process.stdout.write(HELP);
        return 0;
    }
    const doFix = flags.has("--fix");
    const autoYes = flags.has("--yes");
    const root = findRepoRoot();
    if (!root) {
        fail("not inside a git repo (git rev-parse --show-toplevel failed)");
        return 1;
    }
    process.stdout.write(`${c.bold("repo:")} ${c.cyan(root)}\n`);
    const tracked = gitLsFiles(root);
    if (tracked.length === 0) {
        warn("no tracked files (empty repo?) — skipping checks");
        return 0;
    }
    const stack = detectStack(tracked);
    const stackLabels = [];
    if (stack.maven)
        stackLabels.push("maven");
    if (stack.gradle)
        stackLabels.push("gradle");
    if (stack.android)
        stackLabels.push("android");
    if (stack.node)
        stackLabels.push("node");
    if (stack.python)
        stackLabels.push("python");
    process.stdout.write(`${c.bold("stack:")} ${c.cyan(stackLabels.join(", ") || "(unknown)")}\n\n`);
    const issues = [];
    const gitignorePath = join(root, ".gitignore");
    const hasGitignore = existsSync(gitignorePath);
    process.stdout.write(".gitignore:\n");
    if (!hasGitignore) {
        fail("no .gitignore at repo root");
        issues.push({ kind: "no-gitignore", detail: [] });
    }
    else {
        ok(".gitignore present");
        const existing = readFileSync(gitignorePath, "utf8");
        const presentLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
        const missing = expectedPatternsFor(stack).filter((p) => !presentLines.has(p));
        if (missing.length > 0) {
            warn(`missing patterns for detected stack: ${missing.join(", ")}`);
            issues.push({ kind: "missing-patterns", detail: missing });
        }
        else {
            ok("covers detected stack");
        }
    }
    process.stdout.write("\ntracked artifacts:\n");
    const artifacts = findTrackedArtifacts(tracked);
    if (artifacts.length === 0) {
        ok("no build artifacts tracked");
    }
    else {
        const total = artifacts.reduce((n, b) => n + b.paths.length, 0);
        fail(`${total} tracked path(s) matching build-artifact patterns`);
        for (const b of artifacts) {
            info(`${b.rule}  (${b.paths.length})`);
            for (const p of b.paths.slice(0, 3))
                info(`  ${p}`);
            if (b.paths.length > 3)
                info(`  ... and ${b.paths.length - 3} more`);
        }
        issues.push({
            kind: "tracked-artifacts",
            detail: artifacts.flatMap((b) => b.paths),
        });
    }
    process.stdout.write("\nsubmodules:\n");
    const broken = findBrokenGitlinks(root);
    if (broken.length === 0) {
        ok("no broken gitlinks");
    }
    else {
        fail(`${broken.length} gitlink(s) without a .gitmodules entry`);
        for (const p of broken)
            info(p);
        issues.push({ kind: "broken-gitlink", detail: broken });
    }
    if (issues.length === 0) {
        process.stdout.write(`\n${sym.ok} ${c.green("repo is clean")}\n`);
        return 0;
    }
    if (!doFix) {
        process.stdout.write(`\n${c.dim("run with --fix to apply fixes")}\n`);
        return 1;
    }
    process.stdout.write("\n" + c.bold("applying fixes:") + "\n");
    for (const iss of issues) {
        if (iss.kind === "no-gitignore") {
            const content = buildGitignore(stack);
            info(`will write .gitignore (${content.split("\n").length} lines)`);
            if (await confirm("  write .gitignore?", autoYes)) {
                writeFileSync(gitignorePath, content, "utf8");
                ok("wrote .gitignore");
            }
            else {
                warn("skipped .gitignore");
            }
        }
        else if (iss.kind === "missing-patterns") {
            const existing = readFileSync(gitignorePath, "utf8");
            const { merged, added } = mergeGitignore(existing, stack);
            info(`will append ${added.length} pattern(s): ${added.join(", ")}`);
            if (await confirm("  append to .gitignore?", autoYes)) {
                writeFileSync(gitignorePath, merged, "utf8");
                ok(`appended ${added.length} pattern(s)`);
            }
            else {
                warn("skipped .gitignore patch");
            }
        }
        else if (iss.kind === "tracked-artifacts") {
            info(`will run: git rm -r --cached <${iss.detail.length} path(s)>`);
            if (await confirm("  untrack these paths?", autoYes)) {
                // Batch in chunks to avoid command-line length limits on Windows.
                const chunkSize = 100;
                let failed = 0;
                for (let i = 0; i < iss.detail.length; i += chunkSize) {
                    const chunk = iss.detail.slice(i, i + chunkSize);
                    const r = execSync("git", ["-C", root, "rm", "-r", "--cached", "--", ...chunk]);
                    if (!r.ok) {
                        failed += chunk.length;
                        warn(`batch ${i / chunkSize + 1} failed: ${r.stderr.trim().split(/\r?\n/)[0]}`);
                    }
                }
                if (failed === 0)
                    ok(`untracked ${iss.detail.length} path(s) — commit to record removal`);
                else
                    fail(`${failed} path(s) failed to untrack`);
            }
            else {
                warn("skipped untrack");
            }
        }
        else if (iss.kind === "broken-gitlink") {
            warn("broken gitlinks need manual handling:");
            info("- to make it a real submodule:  git submodule add <url> <path>");
            info("- to remove the gitlink:        git rm <path>");
        }
    }
    return 0;
}
//# sourceMappingURL=repo.js.map