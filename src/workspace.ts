import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";

export const MAX_GLOBAL_REPOS = 200;

export interface RepoInfo {
  /** Absolute path to the repo. */
  path: string;
  /** Repo directory name (basename of path). */
  name: string;
  /** Parent directory name when the repo lives one level below cwd; "" for direct children. */
  category: string;
}

export function isRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

export function listChildDirs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

/**
 * Two-level scan for git repositories.
 *
 * Direct children that are repos are returned as-is; direct children that are
 * not repos are treated as category folders and their own children are
 * scanned one level deeper. Handles both `c:/chevp/tools` (direct child repos)
 * and `c:/chevp` (category folders containing repos).
 */
export function discoverRepos(dir: string): RepoInfo[] {
  const repos: RepoInfo[] = [];
  for (const child of listChildDirs(dir)) {
    if (isRepo(child)) {
      repos.push({ path: child, name: basename(child), category: "" });
      if (repos.length >= MAX_GLOBAL_REPOS) return repos;
      continue;
    }
    const cat = basename(child);
    for (const grand of listChildDirs(child)) {
      if (isRepo(grand)) {
        repos.push({ path: grand, name: basename(grand), category: cat });
        if (repos.length >= MAX_GLOBAL_REPOS) return repos;
      }
    }
  }
  return repos;
}

export function groupByCategory(repos: RepoInfo[]): Map<string, RepoInfo[]> {
  const groups = new Map<string, RepoInfo[]>();
  for (const r of repos) {
    const arr = groups.get(r.category) ?? [];
    arr.push(r);
    groups.set(r.category, arr);
  }
  return groups;
}

export function repoLabel(info: RepoInfo): string {
  return info.category ? `${info.category}/${info.name}` : info.name;
}

export type WorkspaceMode = "workspace" | "repo";

export interface WorkspaceRoot {
  mode: WorkspaceMode;
  root: string;
}

/**
 * Walk up from `cwd` until we find a `.git` directory. Falls back to `cwd`
 * if nothing matches. Used by per-repo commands like `chi plan` whose targets
 * (context/plans, context/adr) are repo-local — never workspace-wide.
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  const { root: fsRoot } = parse(cwd);
  let current = cwd;
  while (true) {
    if (isRepo(current)) return current;
    if (current === fsRoot) return cwd;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

const WORKSPACE_MARKERS = [/chevp-workflow/i, /Workspace Mode/i];

function looksLikeWorkspaceRoot(dir: string): boolean {
  const claudeMd = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return false;
  let text: string;
  try {
    text = readFileSync(claudeMd, "utf8");
  } catch {
    return false;
  }
  if (!WORKSPACE_MARKERS.some((re) => re.test(text))) return false;
  // Heuristic: a workspace root must contain at least one sub-directory that
  // is itself a git repo (direct child) OR contain category folders whose
  // children are repos. Walk one or two levels — same depth as discoverRepos.
  for (const child of listChildDirs(dir)) {
    if (isRepo(child)) return true;
    for (const grand of listChildDirs(child)) {
      if (isRepo(grand)) return true;
    }
  }
  return false;
}

/**
 * Walk up from `cwd` until we find either a workspace root (CLAUDE.md mentions
 * "chevp-workflow"/"Workspace Mode" *and* the directory contains sub-repos) or
 * a single git repo. Workspace mode wins when both could match — the outermost
 * matching ancestor with workspace markers is preferred so `chi consult` run
 * from inside `~/workspace/tools/chi` still gets the cross-repo view when the
 * user is doing workspace-level work and explicitly asked for it via flag.
 *
 * For v1 the default is "nearest match": if the immediate dir is a repo we
 * stay in repo mode. Workspace mode is opt-in via the upcoming `--workspace`
 * flag or by starting `chi consult` from the workspace root itself. H3 in
 * CTX-002 — keep this resolver small.
 */
export function resolveWorkspaceRoot(cwd: string = process.cwd()): WorkspaceRoot {
  const { root: fsRoot } = parse(cwd);
  let current = cwd;
  // First pass: nearest repo. This is the default cwd for the orchestrator.
  let nearestRepo: string | null = null;
  while (true) {
    if (isRepo(current)) {
      nearestRepo = current;
      break;
    }
    if (current === fsRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Second pass: workspace marker anywhere from cwd upward.
  current = cwd;
  while (true) {
    if (looksLikeWorkspaceRoot(current)) {
      return { mode: "workspace", root: current };
    }
    if (current === fsRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (nearestRepo) return { mode: "repo", root: nearestRepo };
  return { mode: "repo", root: cwd };
}
