import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execAsync, commandExists } from "../spawn.js";
import { pool } from "../concurrency.js";
import { c } from "../ui.js";
import { BIN_NAME } from "../identity.js";
import {
  discoverRepos,
  repoLabel,
  resolveWorkspaceRoot,
  isRepo,
  type RepoInfo,
} from "../workspace.js";

const HELP = `${BIN_NAME} inspect — repo snapshot across the workspace (like git diff --stat).

Usage: ${BIN_NAME} inspect [options]

Prints one row per git repo under the workspace root with:
  LOC          lines of hand-written code (k = thousands); binary, generated
               (lockfiles, *.min.*) and markup/data/docs (html, json, md, txt,
               svg, csv, xml, ...) are excluded
  FILES        tracked files
  SUB          git submodules (.gitmodules)
  CX           complexity heuristic 0-10 (blend of LOC, files, submodules)
  SCALE        🟢 CX<4.5   🟠 CX<7   🔴 CX≥7
  VIS          public / private (via gh; skipped with --no-vis)
  SIZE         visual bar: '+' scales with LOC, '◆' = one per submodule

Options:
  --no-vis     skip the public/private lookup (no network, faster)
  --json       emit machine-readable JSON instead of the table
  -h, --help   show this help
`;

// Extensions we never read for LOC — clearly binary / asset payloads.
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "mov", "webm", "avi", "mkv", "mp3", "wav", "ogg", "flac",
  "pdf", "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar",
  "jar", "war", "class", "so", "dylib", "dll", "exe", "wasm", "bin", "dat",
  "glb", "ktx", "dds", "pak", "o", "a", "lib", "node",
]);

// Built / vendored / generated directories — excluded from LOC, FILES and
// DEPS even when the repo tracks them (chi & luma commit their dist/, etc.).
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "packages", "target", "out", "bin", "obj",
  "vendor", "third_party", "generated", "coverage", "__pycache__", ".venv", "venv",
  ".gradle", ".next", ".nuxt", ".svelte-kit", ".angular", ".turbo",
  ".cache", ".parcel-cache", "deps",
  // Project-specific vendor dirs that don't follow the common naming above.
  "ocean_modules",
]);

/** True if any path segment is a built / vendored directory. */
function isBuiltPath(relPath: string): boolean {
  for (const seg of relPath.split("/")) {
    if (EXCLUDED_DIRS.has(seg)) return true;
    if (seg.startsWith("cmake-build")) return true;
  }
  return false;
}

interface RepoMetrics {
  label: string;
  loc: number;
  files: number;
  submodules: number;
  complexity: number;
  scale: string;
  visibility: "public" | "private" | "—";
}

function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return "";
  return path.slice(dot + 1).toLowerCase();
}

// Lock / generated files: real lines, but noise for a complexity signal —
// they dwarf hand-written source and would peg every repo at max.
const GENERATED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "cargo.lock", "poetry.lock", "composer.lock", "go.sum", "gemfile.lock",
  "pubspec.lock", "flake.lock",
]);

function isGenerated(relPath: string): boolean {
  const name = (relPath.split("/").pop() ?? "").toLowerCase();
  if (GENERATED_FILES.has(name)) return true;
  return /\.min\.(js|css)$/.test(name) || name.endsWith(".map");
}

// Text, but not code — markup / data / docs. Excluded from LOC (still counted
// in FILES). Keeps the LOC figure closer to actual hand-written code.
const NON_CODE_EXT = new Set([
  "html", "htm", "json", "json5", "geojson",
  "md", "markdown", "mdx", "txt", "rst", "adoc",
  "svg", "csv", "tsv", "xml",
]);

/** Source lines in a text file; 0 for binary / data / generated / unreadable. */
function countLines(abs: string, relPath: string): number {
  const e = ext(relPath);
  if (BINARY_EXT.has(e) || NON_CODE_EXT.has(e) || isGenerated(relPath)) return 0;
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return 0;
  }
  if (buf.length === 0) return 0;
  // NUL byte in the first chunk ⇒ treat as binary.
  const probe = buf.subarray(0, Math.min(buf.length, 8000));
  if (probe.includes(0)) return 0;
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines++;
  }
  // Count a trailing partial line (file not ending in newline).
  if (buf[buf.length - 1] !== 0x0a) lines++;
  return lines;
}

/** Number of git submodules declared in the repo's .gitmodules. */
function countSubmodules(root: string): number {
  let text: string;
  try {
    text = readFileSync(join(root, ".gitmodules"), "utf8");
  } catch {
    return 0;
  }
  return (text.match(/^\s*\[submodule\b/gim) ?? []).length;
}

/**
 * Complexity heuristic, 0-10. Blends code volume, surface area (file count)
 * and submodule coupling on a log scale so a 10× repo does not read as 10× the
 * score. Deliberately coarse — a relative signal, not a metric.
 */
function complexityScore(loc: number, files: number, subs: number): number {
  const mass = loc + 40 * files + 500 * subs;
  const raw = (Math.log10(mass + 1) - 2.6) * 2.5;
  return Math.max(0, Math.min(10, raw));
}

function scaleDot(cx: number): string {
  if (cx >= 7) return "🔴";
  if (cx >= 4.5) return "🟠";
  return "🟢";
}

function humanK(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

async function trackedFiles(root: string): Promise<string[]> {
  const r = await execAsync("git", ["-C", root, "ls-files", "-z"]);
  if (!r.ok) return [];
  return r.stdout.split("\0").filter((p) => p.length > 0);
}

async function visibilityOf(root: string, lookup: boolean): Promise<"public" | "private" | "—"> {
  if (!lookup) return "—";
  const r = await execAsync(
    "gh",
    ["repo", "view", "--json", "visibility", "--jq", ".visibility"],
    { cwd: root, timeoutMs: 8000 },
  );
  if (!r.ok) return "—";
  const v = r.stdout.trim().toLowerCase();
  if (v === "public" || v === "internal") return "public";
  if (v === "private") return "private";
  return "—";
}

async function measure(info: RepoInfo, lookupVis: boolean): Promise<RepoMetrics> {
  const tracked = (await trackedFiles(info.path)).filter((rel) => !isBuiltPath(rel));
  let loc = 0;
  for (const rel of tracked) loc += countLines(join(info.path, rel), rel);
  const submodules = countSubmodules(info.path);
  const complexity = complexityScore(loc, tracked.length, submodules);
  const visibility = await visibilityOf(info.path, lookupVis);
  return {
    label: repoLabel(info),
    loc,
    files: tracked.length,
    submodules,
    complexity,
    scale: scaleDot(complexity),
    visibility,
  };
}

function colorVis(v: RepoMetrics["visibility"]): string {
  if (v === "public") return c.green(v);
  if (v === "private") return c.yellow(v);
  return c.dim(v);
}

// Max width of the '+' size bar. Length scales with sqrt(loc) relative to the
// largest repo, so the giant does not flatten every other row to nothing.
const BAR_W = 20;

function sizeBar(loc: number, maxLoc: number, subs: number): string {
  const len = loc > 0 && maxLoc > 0 ? Math.max(1, Math.round(BAR_W * Math.sqrt(loc / maxLoc))) : 0;
  const bars = c.cyan("+".repeat(len));
  const dots = subs > 0 ? " " + c.magenta("◆".repeat(subs)) : "";
  return bars + dots;
}

function renderTable(rows: RepoMetrics[]): void {
  const repoW = Math.max(24, ...rows.map((r) => r.label.length), "REPOSITORY".length);
  const maxLoc = Math.max(1, ...rows.map((r) => r.loc));
  const VIS = 8, LOC = 7, FILES = 6, SUB = 4, CX = 5;

  const head =
    "REPOSITORY".padEnd(repoW) +
    "  " + "VIS".padEnd(VIS) +
    "  " + "LOC".padStart(LOC) +
    "  " + "FILES".padStart(FILES) +
    "  " + "SUB".padStart(SUB) +
    "  " + "CX".padStart(CX) +
    "  " + "SCALE" +
    "  " + "SIZE  (+ loc · ◆ submodule)";
  process.stdout.write(c.bold(head) + "\n");
  process.stdout.write(c.dim("─".repeat(repoW + VIS + LOC + FILES + SUB + CX + 22)) + "\n");

  for (const r of rows) {
    const line =
      r.label.padEnd(repoW) +
      "  " + colorVis(r.visibility) + " ".repeat(Math.max(0, VIS - r.visibility.length)) +
      "  " + c.cyan(humanK(r.loc).padStart(LOC)) +
      "  " + humanK(r.files).padStart(FILES) +
      "  " + `${r.submodules}`.padStart(SUB) +
      "  " + r.complexity.toFixed(1).padStart(CX) +
      "  " + r.scale +
      "  " + sizeBar(r.loc, maxLoc, r.submodules);
    process.stdout.write(line + "\n");
  }
}

export async function run(argv: string[]): Promise<number> {
  const flags = new Set(argv);
  if (flags.has("-h") || flags.has("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const asJson = flags.has("--json");
  const lookupVis = !flags.has("--no-vis") && commandExists("gh");

  const cwd = process.cwd();
  const ws = resolveWorkspaceRoot(cwd);

  let repos: RepoInfo[];
  if (ws.mode === "workspace") {
    repos = discoverRepos(ws.root);
  } else if (isRepo(ws.root)) {
    repos = [{ path: ws.root, name: ws.root.split(/[\\/]/).pop() ?? ws.root, category: "" }];
  } else {
    repos = [];
  }

  if (repos.length === 0) {
    process.stderr.write(
      `${BIN_NAME} inspect: no git repositories found under ${ws.root.replace(/\\/g, "/")}\n`,
    );
    return 1;
  }

  const rows = await pool(repos, (info) => measure(info, lookupVis), 8);
  rows.sort((a, b) => b.complexity - a.complexity);

  if (asJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  renderTable(rows);
  return 0;
}
