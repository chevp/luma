import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists } from "../spawn.js";
import { git, isInsideRepo, repoRoot, currentBranch, porcelain, upstreamRef } from "../git/index.js";
import { BIN_NAME } from "../identity.js";
import { c } from "../ui.js";

const HELP = `${BIN_NAME} release — bump the version, commit, tag, and push.

Usage:
  ${BIN_NAME} release                  bump patch, commit, tag vX.Y.Z, push
  ${BIN_NAME} release patch|minor|major   bump that level
  ${BIN_NAME} release X.Y.Z            set package.json to that exact version
  ${BIN_NAME} release --no-bump        tag the current package.json version as-is

The bump commit message is "release vX.Y.Z". The tag is annotated with the
same string (override with --message). After pushing, a configured CI workflow
(on: push: tags: ['v*']) can publish a GitHub Release.

Options:
  -m, --message <msg>   tag annotation message (default: the version)
      --no-bump         skip the version bump; tag whatever is in package.json
      --no-push         do everything locally; don't push commit or tag
      --remote <name>   remote to push to (default: origin)
  -h, --help            show this help
`;

type BumpLevel = "patch" | "minor" | "major";

interface Args {
  /** Explicit X.Y.Z target, or null if not given. */
  version: string | null;
  /** patch/minor/major when a level keyword was given. */
  level: BumpLevel | null;
  /** Skip bumping entirely (use whatever is in package.json). */
  noBump: boolean;
  message: string | null;
  push: boolean;
  remote: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = {
    version: null,
    level: null,
    noBump: false,
    message: null,
    push: true,
    remote: "origin",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") return { error: "__help__" };
    if (a === "-m" || a === "--message") {
      const v = argv[++i];
      if (!v) return { error: `${a} needs a value` };
      out.message = v;
      continue;
    }
    if (a === "--no-bump") {
      out.noBump = true;
      continue;
    }
    if (a === "--no-push") {
      out.push = false;
      continue;
    }
    if (a === "--remote") {
      const v = argv[++i];
      if (!v) return { error: `--remote needs a value` };
      out.remote = v;
      continue;
    }
    if (a.startsWith("-")) return { error: `unknown option '${a}'` };
    if (out.version !== null || out.level !== null) {
      return { error: `unexpected argument '${a}'` };
    }
    if (a === "patch" || a === "minor" || a === "major") {
      out.level = a;
    } else {
      out.version = a;
    }
  }
  return out;
}

/** Increment a semver string by the given level. Returns null if unparseable. */
function nextSemver(version: string, level: BumpLevel): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!m) return null;
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  const patch = Number.parseInt(m[3] ?? "0", 10);
  const suffix = m[4] ?? "";
  if (level === "major") return `${major + 1}.0.0${suffix}`;
  if (level === "minor") return `${major}.${minor + 1}.0${suffix}`;
  return `${major}.${minor}.${patch + 1}${suffix}`;
}

/**
 * Write `version` into <root>/package.json, preserving the file's existing
 * indent and trailing newline. Returns the previous version, or null if the
 * file doesn't exist or has no string version field.
 */
function writePackageVersion(root: string, version: string): string | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let pkg: { version?: unknown; [k: string]: unknown };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof pkg.version !== "string") return null;
  const previous = pkg.version;
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
  const trailing = raw.endsWith("\n") ? "\n" : "";
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, indent) + trailing);
  return previous;
}

function readPackageVersion(root: string): string | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof json.version === "string" && json.version.length > 0 ? json.version : null;
  } catch {
    return null;
  }
}

function normalizeTag(input: string): string | null {
  const stripped = input.startsWith("v") || input.startsWith("V") ? input.slice(1) : input;
  // semver-ish: X.Y.Z with optional -prerelease and +build
  if (!/^\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]+)?$/.test(stripped)) return null;
  return `v${stripped}`;
}

export async function run(argv: string[]): Promise<number> {
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
  const currentVersion = readPackageVersion(root);

  // Decide the target version. Priority:
  //   1. explicit X.Y.Z arg
  //   2. patch|minor|major (or no arg, defaults to patch) → bump from package.json
  //   3. --no-bump → use package.json as-is
  let targetVersion: string | null;
  if (parsed.version) {
    targetVersion = parsed.version;
  } else if (parsed.noBump) {
    targetVersion = currentVersion;
  } else {
    if (!currentVersion) {
      process.stderr.write(
        `${BIN_NAME} release: no version in package.json — supply one (${BIN_NAME} release X.Y.Z)\n`,
      );
      return 1;
    }
    const level: BumpLevel = parsed.level ?? "patch";
    const next = nextSemver(currentVersion, level);
    if (!next) {
      process.stderr.write(
        `${BIN_NAME} release: current version '${currentVersion}' is not parseable semver\n`,
      );
      return 1;
    }
    targetVersion = next;
  }
  if (!targetVersion) {
    process.stderr.write(
      `${BIN_NAME} release: no version supplied and no package.json/version found\n` +
        `usage: ${BIN_NAME} release <patch|minor|major|X.Y.Z>\n`,
    );
    return 1;
  }

  const tag = normalizeTag(targetVersion);
  if (!tag) {
    process.stderr.write(
      `${BIN_NAME} release: '${targetVersion}' is not a valid semver version (expected X.Y.Z)\n`,
    );
    return 1;
  }

  const exists = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).ok;
  if (exists) {
    process.stderr.write(`${BIN_NAME} release: tag ${tag} already exists\n`);
    return 1;
  }

  const counts = porcelain();
  if (counts.total > 0) {
    process.stderr.write(
      `${BIN_NAME} release: working tree has uncommitted changes ` +
        `(${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked)\n` +
        `commit or stash them before tagging\n`,
    );
    return 1;
  }

  const branch = currentBranch();
  const message = parsed.message ?? tag;

  // Bump phase: write package.json + commit. Skipped when --no-bump, or when
  // the file already has the target version (e.g. `luma release X.Y.Z` and
  // X.Y.Z matches what's on disk).
  const needsBump = !parsed.noBump && currentVersion !== null && currentVersion !== targetVersion;
  if (needsBump) {
    const previous = writePackageVersion(root, targetVersion);
    if (previous === null) {
      process.stderr.write(
        `${BIN_NAME} release: failed to write package.json — aborting before tag\n`,
      );
      return 1;
    }
    const add = git(["add", "--", "package.json"]);
    if (!add.ok) {
      process.stderr.write(add.stderr || `failed to stage package.json\n`);
      return add.status ?? 1;
    }
    const commit = git(["commit", "-m", `release ${tag}`]);
    if (!commit.ok) {
      process.stderr.write(commit.stderr || `failed to commit version bump\n`);
      return commit.status ?? 1;
    }
    process.stdout.write(
      `${c.green("✓")} bumped package.json ${c.dim(`${previous} →`)} ${c.green(targetVersion)}\n`,
    );
  }

  const tagRes = git(["tag", "-a", tag, "-m", message]);
  if (!tagRes.ok) {
    process.stderr.write(tagRes.stderr || `failed to create tag ${tag}\n`);
    return tagRes.status ?? 1;
  }
  process.stdout.write(`${c.green("✓")} created annotated tag ${c.cyan(tag)} on ${branch}\n`);

  if (!parsed.push) {
    process.stdout.write(
      `note: --no-push given, push later with: git push ${parsed.remote} ${branch} && git push ${parsed.remote} ${tag}\n`,
    );
    return 0;
  }

  if (!upstreamRef()) {
    process.stderr.write(
      `${BIN_NAME} release: branch '${branch}' has no upstream — pushing tag to '${parsed.remote}' anyway\n`,
    );
  }

  // Push the bump commit before the tag so origin sees the commit the tag
  // points to. Without this, a fresh clone may end up with a tag pointing to
  // an unreachable commit (depending on the remote's tag-following config).
  if (needsBump && upstreamRef()) {
    const pushBranch = git(["push", parsed.remote, branch]);
    process.stdout.write(pushBranch.stdout);
    if (!pushBranch.ok) {
      process.stderr.write(pushBranch.stderr);
      process.stderr.write(
        `\n${c.red(`${BIN_NAME} release: bump commit created locally but push to ${parsed.remote} failed`)}\n` +
          `retry with: git push ${parsed.remote} ${branch} && git push ${parsed.remote} ${tag}\n`,
      );
      return pushBranch.status ?? 1;
    }
    process.stdout.write(`${c.green("✓")} pushed ${c.cyan(branch)} to ${parsed.remote}\n`);
  }

  const pushRes = git(["push", parsed.remote, tag]);
  process.stdout.write(pushRes.stdout);
  if (!pushRes.ok) {
    process.stderr.write(pushRes.stderr);
    process.stderr.write(
      `\n${c.red(`${BIN_NAME} release: tag created locally but push to ${parsed.remote} failed`)}\n` +
        `retry with: git push ${parsed.remote} ${tag}\n` +
        `or remove the local tag: git tag -d ${tag}\n`,
    );
    return pushRes.status ?? 1;
  }
  process.stdout.write(`${c.green("✓")} pushed ${c.cyan(tag)} to ${parsed.remote}\n`);
  return 0;
}
