import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { c } from "../ui.js";
import { commandExists } from "../spawn.js";
import { git, isInsideRepo, repoRoot } from "../git/index.js";
import { BIN_NAME } from "../identity.js";

const HELP = `${BIN_NAME} work — manage parallel git worktrees.

Usage:
  ${BIN_NAME} work <name> [--base <branch>]   create a worktree at ../<repo>-<name>
                                       on branch chi/<name>
  ${BIN_NAME} work list                        list chi-managed worktrees
  ${BIN_NAME} work rm [<name>] [--force]       remove worktree (current if no name)
  ${BIN_NAME} work cd <name>                   print path of worktree (for shell aliases)
  ${BIN_NAME} work -h | --help                 show this help

Env:
  CHI_WORKTREE_ROOT            override parent dir for new worktrees
  CHI_WORKTREE_BRANCH_PREFIX   override "chi/" branch prefix
`;

interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
}

export interface ChiWorktreeMeta {
  name: string;
  branch: string;
  base: string;
  source: string;
  createdAt: string;
}

function commonGitDir(cwd?: string): string {
  return git(["rev-parse", "--git-common-dir"], cwd).stdout.trim();
}

function listAllWorktrees(cwd?: string): WorktreeEntry[] {
  const r = git(["worktree", "list", "--porcelain"], cwd);
  if (!r.ok) return [];
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  const flush = (): void => {
    if (cur && cur.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? "",
        head: cur.head ?? "",
        bare: cur.bare ?? false,
        detached: cur.detached ?? false,
      });
    }
    cur = null;
  };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7);
    } else if (cur && line === "bare") {
      cur.bare = true;
    } else if (cur && line === "detached") {
      cur.detached = true;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return out;
}

function markerPath(worktreePath: string, common: string): string {
  return `${common}/worktrees/${basename(worktreePath)}/chi-worktree`;
}

function readMarker(path: string): ChiWorktreeMeta | null {
  try {
    const raw = readFileSync(path, "utf8");
    const m: Partial<ChiWorktreeMeta> = {};
    for (const ln of raw.split(/\r?\n/)) {
      const eq = ln.indexOf("=");
      if (eq < 0) continue;
      const k = ln.slice(0, eq).trim();
      const v = ln.slice(eq + 1).trim();
      if (k === "name") m.name = v;
      else if (k === "branch") m.branch = v;
      else if (k === "base") m.base = v;
      else if (k === "source") m.source = v;
      else if (k === "created_at") m.createdAt = v;
    }
    if (!m.name || !m.branch) return null;
    return m as ChiWorktreeMeta;
  } catch {
    return null;
  }
}

function defaultRoot(repoRootPath: string): string {
  const env = process.env.CHI_WORKTREE_ROOT;
  if (env && env.trim()) return env;
  return dirname(repoRootPath);
}

function branchPrefix(): string {
  const env = process.env.CHI_WORKTREE_BRANCH_PREFIX;
  if (env !== undefined) return env;
  return "chi/";
}

function deriveWorktreePath(name: string, repoRootPath: string): string {
  return resolve(defaultRoot(repoRootPath), `${basename(repoRootPath)}-${name}`);
}

function isClean(worktreePath: string): boolean {
  const r = git(["status", "--porcelain"], worktreePath);
  return r.ok && r.stdout.trim() === "";
}

export interface ActiveChiFlow {
  worktreePath: string;
  /** Contents of <per-worktree-gitdir>/chi-flow (branch=, base=, pr=, issue=). */
  flow: { branch: string; base: string; pr: string; issue: string };
  meta: ChiWorktreeMeta;
}

/**
 * Returns chi-managed worktrees that have an active chi-flow marker. Used by
 * `chi ship` (clean source repo) to point the user at parallel work that
 * needs shipping from elsewhere.
 */
export function listActiveChiFlows(): ActiveChiFlow[] {
  if (!isInsideRepo()) return [];
  const common = commonGitDir();
  if (!common) return [];
  const out: ActiveChiFlow[] = [];
  for (const w of listAllWorktrees()) {
    const mp = markerPath(w.path, common);
    if (!existsSync(mp)) continue;
    const meta = readMarker(mp);
    if (!meta) continue;
    const wtGitDir = `${common}/worktrees/${basename(w.path)}`;
    const flowPath = `${wtGitDir}/chi-flow`;
    if (!existsSync(flowPath)) continue;
    const flow = { branch: "", base: "", pr: "", issue: "" };
    try {
      const raw = readFileSync(flowPath, "utf8");
      for (const ln of raw.split(/\r?\n/)) {
        const eq = ln.indexOf("=");
        if (eq < 0) continue;
        const k = ln.slice(0, eq).trim();
        const v = ln.slice(eq + 1).trim();
        if (k === "branch") flow.branch = v;
        else if (k === "base") flow.base = v;
        else if (k === "pr") flow.pr = v;
        else if (k === "issue") flow.issue = v;
      }
    } catch {
      continue;
    }
    out.push({ worktreePath: w.path, flow, meta });
  }
  return out;
}

/**
 * Returns metadata when cwd is inside a chi-managed worktree (not the main
 * repo). Used by `chi done` to detect worktree-aware cleanup paths.
 */
export function detectChiWorktree(): { worktreePath: string; meta: ChiWorktreeMeta } | null {
  if (!isInsideRepo()) return null;
  const gd = git(["rev-parse", "--git-dir"]).stdout.trim();
  const cd = git(["rev-parse", "--git-common-dir"]).stdout.trim();
  if (!gd || !cd) return null;
  const top = repoRoot();
  if (!top) return null;
  const absGd = isAbsolute(gd) ? gd : resolve(top, gd);
  const absCd = isAbsolute(cd) ? cd : resolve(top, cd);
  if (resolve(absGd) === resolve(absCd)) return null;
  const marker = `${absGd}/chi-worktree`;
  if (!existsSync(marker)) return null;
  const meta = readMarker(marker);
  if (!meta) return null;
  return { worktreePath: top, meta };
}

export interface CreateWorktreeOpts {
  /** Base branch the worktree starts from. Default "main". */
  base?: string;
  /** Override the auto-derived branch (default `${branchPrefix()}${name}`). */
  branch?: string;
}

export interface CreateWorktreeResult {
  ok: boolean;
  path?: string;
  branch?: string;
  /** Human-readable error if ok=false. Already written to stderr. */
  error?: string;
}

/**
 * Programmatic worktree creator. Used by both `chi work <name>` and by
 * `chi issue fix <N>` (which wants a custom branch name).
 *
 * Side effects: writes to stderr on failure, writes the chi-worktree marker
 * on success. Does NOT print success banner — callers do that themselves so
 * they can fold it into their own UX.
 */
export function createWorktree(name: string, opts: CreateWorktreeOpts = {}): CreateWorktreeResult {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    const error = `${BIN_NAME} work: invalid name '${name}' — use [A-Za-z0-9._-]`;
    process.stderr.write(`${error}\n`);
    return { ok: false, error };
  }

  const root = repoRoot();
  if (!root) {
    const error = `${BIN_NAME} work: cannot resolve repo root`;
    process.stderr.write(`${error}\n`);
    return { ok: false, error };
  }

  const base = opts.base ?? "main";
  const branch = opts.branch ?? `${branchPrefix()}${name}`;
  const wtPath = deriveWorktreePath(name, root);

  if (existsSync(wtPath)) {
    const error = `${BIN_NAME} work: path already exists: ${wtPath}`;
    process.stderr.write(`${error}\n`);
    return { ok: false, error };
  }
  if (git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    const error = `${BIN_NAME} work: branch '${branch}' already exists`;
    process.stderr.write(`${error}\n`);
    return { ok: false, error };
  }
  if (!git(["show-ref", "--verify", "--quiet", `refs/heads/${base}`]).ok) {
    const error = `${BIN_NAME} work: base branch '${base}' does not exist locally`;
    process.stderr.write(`${error}\n`);
    return { ok: false, error };
  }

  git(["fetch", "origin", base, "--quiet"]);

  const add = git(["worktree", "add", "-b", branch, wtPath, base]);
  process.stderr.write(add.stderr);
  if (!add.ok) {
    return { ok: false, error: add.stderr || "git worktree add failed" };
  }

  const common = commonGitDir();
  const marker = markerPath(wtPath, common);
  try {
    writeFileSync(
      marker,
      `name=${name}\n` +
        `branch=${branch}\n` +
        `base=${base}\n` +
        `source=${root}\n` +
        `created_at=${new Date().toISOString()}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `${BIN_NAME} work: marker write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return { ok: true, path: wtPath, branch };
}

async function cmdCreate(name: string, base: string): Promise<number> {
  const r = createWorktree(name, { base });
  if (!r.ok) return 1;
  process.stdout.write(`\n${c.bold("── chi work created ──")}\n`);
  process.stdout.write(`  name:   ${name}\n`);
  process.stdout.write(`  path:   ${r.path}\n`);
  process.stdout.write(`  branch: ${r.branch} (from ${base})\n\n`);
  process.stdout.write(`next: cd ${r.path}\n`);
  return 0;
}

async function cmdList(): Promise<number> {
  const common = commonGitDir();
  const wts = listAllWorktrees().filter((w) => existsSync(markerPath(w.path, common)));
  if (wts.length === 0) {
    process.stdout.write(`  ${c.dim("(no chi-managed worktrees)")}\n`);
    return 0;
  }
  for (const w of wts) {
    const meta = readMarker(markerPath(w.path, common));
    const branch = w.detached
      ? "(detached)"
      : w.branch.replace(/^refs\/heads\//, "") || "(unknown)";
    const state = isClean(w.path) ? c.green("clean") : c.yellow("dirty");
    const display = meta?.name ?? basename(w.path);
    process.stdout.write(
      `  ${c.cyan(display.padEnd(20))} ${branch.padEnd(28)} ${state}  ${c.dim(w.path)}\n`,
    );
  }
  return 0;
}

function findWorktreeByName(
  name: string,
  wts: WorktreeEntry[],
  repoBase: string,
): WorktreeEntry | null {
  const direct = wts.find((w) => basename(w.path) === name);
  if (direct) return direct;
  const prefixed = wts.find((w) => basename(w.path) === `${repoBase}-${name}`);
  if (prefixed) return prefixed;
  // Allow exact path match as a last resort.
  try {
    const abs = resolve(name);
    return wts.find((w) => resolve(w.path) === abs) ?? null;
  } catch {
    return null;
  }
}

async function cmdRm(name: string, force: boolean): Promise<number> {
  const common = commonGitDir();
  const wts = listAllWorktrees();
  const here = repoRoot();
  const repoBase = here ? basename(here) : "";

  let target: WorktreeEntry | null = null;
  if (name) {
    target = findWorktreeByName(name, wts, repoBase);
  } else if (here) {
    target = wts.find((w) => resolve(w.path) === resolve(here)) ?? null;
  }
  if (!target) {
    process.stderr.write(`${BIN_NAME} work rm: no worktree matches '${name || "(current)"}'\n`);
    return 1;
  }

  if (!existsSync(markerPath(target.path, common))) {
    process.stderr.write(
      `${BIN_NAME} work rm: '${target.path}' is not chi-managed (no marker) — use 'git worktree remove' directly\n`,
    );
    return 1;
  }

  if (!force && !isClean(target.path)) {
    process.stderr.write(
      `${BIN_NAME} work rm: ${target.path} has uncommitted changes — pass --force to discard\n`,
    );
    return 1;
  }

  // git refuses to remove the worktree the caller is inside; fall back to
  // running from the source repo (recorded in the marker) when that happens.
  const meta = readMarker(markerPath(target.path, common));
  const runFrom =
    here && resolve(here) === resolve(target.path) && meta?.source ? meta.source : undefined;

  const args = ["worktree", "remove", target.path];
  if (force) args.push("--force");
  const r = git(args, runFrom);
  process.stderr.write(r.stderr);
  if (!r.ok) return r.status ?? 1;

  // Delete the local branch too — otherwise re-running `chi work <name>` fails
  // with "branch already exists". Use safe-delete (-d) by default; force-delete
  // (-D) when the user passed --force, matching the dirty-worktree semantics.
  const branchRef = (target.branch || "").replace(/^refs\/heads\//, "") || meta?.branch || "";
  if (branchRef) {
    const delArgs = force ? ["branch", "-D", branchRef] : ["branch", "-d", branchRef];
    const del = git(delArgs, meta?.source);
    if (!del.ok) {
      process.stderr.write(del.stderr);
      process.stderr.write(
        `${BIN_NAME} work rm: worktree gone, but branch '${branchRef}' has unmerged work — push or 'git branch -D ${branchRef}' to drop\n`,
      );
    }
  }

  process.stdout.write(`${c.green("✓ removed:")} ${target.path}\n`);
  return 0;
}

async function cmdCd(name: string): Promise<number> {
  if (!name) {
    process.stderr.write(`${BIN_NAME} work cd: name required\n`);
    return 1;
  }
  const common = commonGitDir();
  const wts = listAllWorktrees();
  const here = repoRoot();
  const repoBase = here ? basename(here) : "";
  const target = findWorktreeByName(name, wts, repoBase);
  if (!target) {
    process.stderr.write(`${BIN_NAME} work cd: no worktree '${name}'\n`);
    return 1;
  }
  if (!existsSync(markerPath(target.path, common))) {
    process.stderr.write(`${BIN_NAME} work cd: '${target.path}' is not chi-managed\n`);
    return 1;
  }
  process.stdout.write(`${target.path}\n`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const first = argv[0] ?? "";
  if (first === "-h" || first === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (!commandExists("git")) {
    process.stderr.write(`${BIN_NAME} work: missing dependency: git (run '${BIN_NAME} doctor git')\n`);
    return 1;
  }
  if (!isInsideRepo()) {
    process.stderr.write(`${BIN_NAME} work: not a git repository\n`);
    return 1;
  }

  switch (first) {
    case "list":
      return cmdList();
    case "rm": {
      let name = "";
      let force = false;
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "-h" || a === "--help") {
          process.stdout.write("Usage: chi work rm [<name>] [--force]\n");
          return 0;
        }
        if (a === "--force" || a === "-f") {
          force = true;
          continue;
        }
        if (a.startsWith("-")) {
          process.stderr.write(`${BIN_NAME} work rm: unknown option '${a}'\n`);
          return 1;
        }
        if (name) {
          process.stderr.write(`${BIN_NAME} work rm: only one name accepted\n`);
          return 1;
        }
        name = a;
      }
      return cmdRm(name, force);
    }
    case "cd": {
      const n = argv[1] ?? "";
      return cmdCd(n);
    }
    default: {
      // Treat first positional as the new worktree name (create).
      let name = "";
      let base = "main";
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "--base") {
          const v = argv[++i];
          if (!v) {
            process.stderr.write(`${BIN_NAME} work: --base needs a value\n`);
            return 1;
          }
          base = v;
          continue;
        }
        if (a.startsWith("-")) {
          process.stderr.write(`${BIN_NAME} work: unknown option '${a}'\n`);
          return 1;
        }
        if (name) {
          process.stderr.write(`${BIN_NAME} work: only one name arg accepted\n`);
          return 1;
        }
        name = a;
      }
      if (!name) {
        process.stderr.write(`${BIN_NAME} work: <name> required\n`);
        process.stderr.write(HELP);
        return 1;
      }
      return cmdCreate(name, base);
    }
  }
}
