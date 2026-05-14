import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { execInherit, execSync } from "../spawn.js";
import { git, isInsideRepo, repoRoot as getRepoRoot } from "../git/index.js";
import { discoverRepos, repoLabel } from "../workspace.js";
import { recoverRepo, printReport, summarize, type RecoveryReport } from "../recover.js";
import { c, kv, section } from "../ui.js";
import { BIN_NAME } from "../identity.js";

// npm 11.x git fetcher leaves node_modules/chi as a dangling symlink to
// <cache>/_cacache/tmp/git-clone<rand> on Windows global installs, so we
// install from a release-asset tarball URL (npm tarball fetcher, different
// pacote code path) instead of github:chevp/chi. The asset is produced by
// .github/workflows/release.yml on every vX.Y.Z tag.
const REMOTE = "https://github.com/chevp/chi/releases/latest/download/chi.tgz";

const HELP = `${BIN_NAME} update — repair workspace state, then update ${BIN_NAME} itself.

Usage: ${BIN_NAME} update [--no-recover] [--no-self]

Phase 1: workspace recovery (default).
  Walks the workspace (or just the current repo) and repairs the kinds of
  damage \`${BIN_NAME} ship\` leaves behind when an autostash-rebase falls over:

    - aborts an in-progress rebase
    - recovers detached HEADs (switches to a branch that contains the commit,
      or to the default branch with a backup of the orphaned SHA)
    - drops every stash entry, archiving each as a patch first
    - clears conflict markers (<<<<<<<) by resetting the file to its indexed
      content; the conflicting side is preserved in the stash backups
    - unstages embedded git repos that \`git add\` slurped in by accident

  Every mutation is preceded by a backup under
  <gitDir>/chi-recover-backup-<timestamp>/.

Phase 2: self-update (default).
  When the running binary resolves into a workspace clone: \`git pull\` →
  \`npm install\` → \`npm run build\` → \`npm pack\` → \`npm install -g <tarball>\`.
  Produces a copied global install (not a symlink) independent of the clone.
  Otherwise (true global install with no .git), reinstalls from ${REMOTE}.

Flags:
  --no-recover     skip phase 1
  --no-self        skip phase 2
  -h, --help       show this help
`;

function findPackageRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function versionLine(oldVer: string | null, newVer: string | null): string {
  const o = oldVer ?? "?";
  const n = newVer ?? "?";
  if (o === n) return `${o} ${c.dim("(unchanged)")}`;
  return `${c.dim(o)} → ${c.green(n)}`;
}

/**
 * `npm install -g <git-url>` crashes with ENOTDIR when the existing entry at
 * `<npm root -g>/<pkg>` is a symlink (e.g. left over from `npm link`): npm's
 * internal rename treats it as a directory. Remove the symlink first so the
 * install can proceed. Prints a notice so the user knows it happened.
 *
 * Returns true if a stale symlink was removed, false otherwise.
 */
function clearStaleGlobalSymlink(): boolean {
  const r = execSync("npm", ["root", "-g"]);
  if (!r.ok) return false;
  const globalDir = r.stdout.trim();
  if (!globalDir) return false;
  const pkgPath = join(globalDir, "chi");
  let stat;
  try {
    stat = lstatSync(pkgPath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    const target = realpathSync(pkgPath);
    unlinkSync(pkgPath);
    process.stdout.write(
      `  ${c.dim(`removed stale symlink ${pkgPath} → ${target}`)}\n`,
    );
    return true;
  } catch (err) {
    process.stderr.write(
      `${BIN_NAME} update: could not remove stale symlink at ${pkgPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * Find any chi-<version>.tgz tarballs left in `root` from previous packs.
 * Used both to clean up before packing fresh and to locate the produced
 * tarball after `npm pack` (whose name varies with the package version).
 */
function findChiTarballs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((f) => /^chi-.*\.tgz$/.test(f))
      .map((f) => join(root, f));
  } catch {
    return [];
  }
}

/**
 * Phase 2 path for workspace clones: pull, install, build, pack, then global-
 * install the tarball. Produces a real copied global install (no symlink to
 * the workspace clone) — sidesteps the npm 11 / `github:` shorthand bug that
 * leaves dangling symlinks to the npm cache temp dir.
 */
async function selfUpdateFromWorkspaceClone(root: string, oldVersion: string | null): Promise<number> {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root).stdout.trim();
  if (!upstream) {
    process.stderr.write(
      `${BIN_NAME} update: workspace clone has no upstream — set one with \`git branch --set-upstream-to=...\`\n`,
    );
    return 1;
  }

  const pull = await execInherit("git", ["pull", "--ff-only", "--autostash"], { cwd: root });
  if (pull !== 0) {
    process.stderr.write(
      `${BIN_NAME} update: git pull failed in ${root} — resolve manually and retry\n`,
    );
    return pull;
  }

  const install = await execInherit("npm", ["install"], { cwd: root });
  if (install !== 0) return install;

  const build = await execInherit("npm", ["run", "build"], { cwd: root });
  if (build !== 0) return build;

  // Clean any stale tarballs from previous attempts so we can identify the
  // one `npm pack` produces this run.
  for (const old of findChiTarballs(root)) {
    try {
      unlinkSync(old);
    } catch {
      // best-effort
    }
  }

  const pack = await execInherit("npm", ["pack"], { cwd: root });
  if (pack !== 0) return pack;

  const tarballs = findChiTarballs(root);
  const tarball = tarballs[0];
  if (!tarball) {
    process.stderr.write(`${BIN_NAME} update: npm pack produced no chi-*.tgz in ${root}\n`);
    return 1;
  }

  clearStaleGlobalSymlink();

  const globalInstall = await execInherit("npm", ["install", "-g", tarball]);

  // Always clean up the tarball, whether install succeeded or failed.
  try {
    unlinkSync(tarball);
  } catch {
    // best-effort
  }

  if (globalInstall !== 0) return globalInstall;

  const newVersion = readPackageVersion(root);
  section(`== summary ==`);
  if (oldVersion && newVersion && oldVersion === newVersion) {
    const newShort = git(["rev-parse", "--short", "HEAD"], root).stdout.trim();
    process.stdout.write(`  ${c.green("✓")} already up to date at v${oldVersion} @ ${newShort}\n\n`);
  } else {
    kv("version", versionLine(oldVersion, newVersion));
    process.stdout.write("\n");
  }
  return 0;
}

/**
 * Phase 2 path for non-workspace installs: just reinstall from the github URL.
 * Known broken on npm 11 + `github:` shorthand on some setups (leaves dangling
 * symlink to npm cache); kept as the fallback since the user can recover with
 * `npm install -g <tarball>` manually.
 */
async function selfUpdateFromGithub(): Promise<number> {
  clearStaleGlobalSymlink();
  const rc = await execInherit("npm", ["install", "-g", REMOTE]);
  if (rc !== 0) return rc;

  const npmRootRes = execSync("npm", ["root", "-g"]);
  const npmGlobalDir = npmRootRes.ok ? npmRootRes.stdout.trim() : "";
  const installedRoot = npmGlobalDir ? join(npmGlobalDir, "chi") : "";
  const newVersion = installedRoot ? readPackageVersion(installedRoot) : null;
  section(`== summary ==`);
  if (newVersion) {
    kv("version", `v${newVersion}`);
  } else {
    process.stdout.write(`  ${c.yellow("install completed but could not read installed version")}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

/**
 * Decide where to pack from. Priority:
 *   1. If the running binary lives inside a workspace clone, use that path.
 *   2. Else, if `process.cwd()` is a chi workspace clone (has .git + a
 *      package.json with name "chi"), use cwd.
 *   3. Else, no workspace source — caller falls back to github URL install.
 *
 * Returns null if no workspace clone could be located.
 */
function locateWorkspaceClone(binRoot: string): string | null {
  if (existsSync(join(binRoot, ".git"))) return binRoot;

  const cwd = process.cwd();
  if (existsSync(join(cwd, ".git"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === "chi") return cwd;
    } catch {
      // not a chi clone, fall through
    }
  }
  return null;
}

async function selfUpdate(): Promise<number> {
  const invokedBin = process.argv[1] ?? "";
  const realBin = invokedBin ? realpathSync(invokedBin) : "";
  const root = findPackageRoot(dirname(realBin));
  if (!root) {
    process.stderr.write(`${BIN_NAME} update: could not locate the chi package root from ${realBin}\n`);
    return 1;
  }

  // Find a workspace clone to pack from: prefer the running binary's root if
  // it's a clone (the npm-link case), otherwise use the current working dir
  // if it's a chi clone. If neither, we're a true global install with no
  // local source — fall back to github URL install.
  const workspaceClone = locateWorkspaceClone(root);
  const npmRootRes = execSync("npm", ["root", "-g"]);
  const npmGlobalDir = npmRootRes.ok ? npmRootRes.stdout.trim() : "";
  const npmGlobalPkg = npmGlobalDir ? join(npmGlobalDir, "chi") : "";

  const oldVersion = readPackageVersion(workspaceClone ?? root);

  section(`== self-update ==`);
  if (workspaceClone === root) {
    kv("location", `workspace clone (${root})`);
  } else if (workspaceClone) {
    kv("location", `global install (${root})`);
    kv("workspace clone", `${workspaceClone} ${c.dim("(via cwd)")}`);
  } else {
    kv("location", `global install (${root})`);
  }
  if (invokedBin && invokedBin !== realBin) {
    kv("invoked as", `${invokedBin} → ${realBin}`);
  }
  if (npmGlobalPkg) {
    kv("install target", npmGlobalPkg);
  } else {
    kv("install target", c.yellow("npm root -g failed — npm install -g may not be available"));
  }
  kv("current version", `v${oldVersion ?? "?"}`);
  kv("source", workspaceClone ? `${workspaceClone} (pack-and-install)` : REMOTE);
  process.stdout.write("\n");

  if (workspaceClone) {
    return selfUpdateFromWorkspaceClone(workspaceClone, oldVersion);
  }
  return selfUpdateFromGithub();
}

function recoverScope(): RecoveryReport[] {
  if (isInsideRepo()) {
    const root = getRepoRoot();
    return [recoverRepo(root, { label: root.split(/[\\/]/).pop() ?? root })];
  }
  const cwd = process.cwd();
  const repos = discoverRepos(cwd);
  if (repos.length === 0) {
    process.stderr.write(
      `${BIN_NAME} update: no git repositories found under ${cwd.replace(/\\/g, "/")}\n`,
    );
    return [];
  }
  process.stdout.write(`${c.bold(`== recover ${repos.length} repos ==`)}\n`);
  const reports: RecoveryReport[] = [];
  for (const info of repos) {
    reports.push(recoverRepo(info.path, { label: repoLabel(info) }));
  }
  return reports;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  const skipRecover = argv.includes("--no-recover");
  const skipSelf = argv.includes("--no-self");

  let recoveryHadErrors = false;

  if (!skipRecover) {
    const reports = recoverScope();
    for (const r of reports) printReport(r);
    if (reports.length > 0) {
      process.stdout.write(`\n${c.bold("== recovery ==")}\n  ${summarize(reports)}\n\n`);
    }
    recoveryHadErrors = reports.some((r) => r.errors.length > 0);
  }

  if (skipSelf) {
    return recoveryHadErrors ? 1 : 0;
  }

  const selfRc = await selfUpdate();
  if (selfRc !== 0) return selfRc;
  return recoveryHadErrors ? 1 : 0;
}
