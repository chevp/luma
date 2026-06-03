import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { git } from "./git/index.js";

export type PreflightKind =
  | "conflict-markers"
  | "invalid-json"
  | "tracked-artifacts";

export interface PreflightFailure {
  kind: PreflightKind;
  path: string;
  detail?: string;
}

const ARTIFACT_PATTERNS: { name: string; test: (p: string) => boolean }[] = [
  { name: ".gradle/", test: (p) => /(^|\/)\.gradle\//.test(p) },
  { name: "target/", test: (p) => /(^|\/)target\//.test(p) },
  { name: "build/", test: (p) => /(^|\/)build\//.test(p) && !/gradle\/wrapper/.test(p) },
  { name: "node_modules/", test: (p) => /(^|\/)node_modules\//.test(p) },
  { name: "*.class", test: (p) => p.endsWith(".class") },
  { name: "__pycache__/", test: (p) => /(^|\/)__pycache__\//.test(p) },
  { name: ".DS_Store", test: (p) => p.endsWith("/.DS_Store") || p === ".DS_Store" },
];

/**
 * Scan a repo for issues that should never reach a push. Returns the list
 * of failures (empty array means clean).
 *
 * Checks:
 *   1. Unresolved git conflict markers in any tracked file (the literal
 *      `<<<<<<<` / `>>>>>>>` lines that survived a botched merge).
 *   2. Invalid JSON in any tracked `*.json` file.
 *   3. Tracked build artifacts (.gradle/, target/, build/, node_modules/,
 *      *.class, __pycache__/, .DS_Store).
 *
 * Override with LUMA_SKIP_PREFLIGHT=1 or the --no-preflight flag (handled
 * by the caller).
 */
export function runPreflight(repoRoot: string): PreflightFailure[] {
  const failures: PreflightFailure[] = [];

  // 1. Conflict markers — pattern requires the marker + " <label>" so we
  // don't false-positive on markdown rules or shell heredocs.
  const grep = git([
    "-C", repoRoot, "grep", "-l", "-E",
    "^(<{7} |>{7} )",
  ]);
  if (grep.ok && grep.stdout.trim()) {
    for (const p of grep.stdout.split(/\r?\n/).filter(Boolean)) {
      failures.push({ kind: "conflict-markers", path: p });
    }
  }

  // 2. JSON validity for tracked *.json files. Skip lockfiles and other
  // generated JSON only if they break (no preemptive skip — if they're
  // tracked they should parse).
  const ls = git(["-C", repoRoot, "ls-files", "--", "*.json"]);
  if (ls.ok) {
    for (const p of ls.stdout.split(/\r?\n/).filter(Boolean)) {
      const abs = join(repoRoot, p);
      if (!existsSync(abs)) continue;
      try {
        JSON.parse(readFileSync(abs, "utf8"));
      } catch (e) {
        failures.push({
          kind: "invalid-json",
          path: p,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // 3. Tracked build artifacts.
  const allTracked = git(["-C", repoRoot, "ls-files"]);
  if (allTracked.ok) {
    const buckets = new Map<string, number>();
    for (const p of allTracked.stdout.split(/\r?\n/).filter(Boolean)) {
      for (const rule of ARTIFACT_PATTERNS) {
        if (rule.test(p)) {
          buckets.set(rule.name, (buckets.get(rule.name) ?? 0) + 1);
          break;
        }
      }
    }
    for (const [rule, count] of buckets) {
      failures.push({
        kind: "tracked-artifacts",
        path: rule,
        detail: `${count} tracked path(s)`,
      });
    }
  }

  return failures;
}
