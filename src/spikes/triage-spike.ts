/**
 * G2 Exploration spike for PRD-002 (workspace-aware `chi ship`).
 * Validates H1: triage + parallelism collapses wall-clock for mostly-clean
 * workspaces to under 10 s on the reference machine.
 *
 * Run:  npx tsx src/spikes/triage-spike.ts <workspace-root>
 *
 * NOT shipped via the dispatcher — this file exists only to produce numbers
 * for insights.md. Production wiring happens in G3.
 */
import { resolve } from "node:path";
import { execAsync } from "../spawn.js";
import { discover } from "../workspace/discover.js";
import { pool } from "../concurrency.js";

type Bucket = "clean" | "dirty" | "ahead" | "no-upstream" | "invalid";

interface TriageResult {
  path: string;
  bucket: Bucket;
  durationMs: number;
}

async function triage(absPath: string): Promise<TriageResult> {
  const t0 = performance.now();

  const status = await execAsync("git", ["-C", absPath, "status", "--porcelain"]);
  if (!status.ok) {
    return { path: absPath, bucket: "invalid", durationMs: performance.now() - t0 };
  }
  if (status.stdout.trim().length > 0) {
    return { path: absPath, bucket: "dirty", durationMs: performance.now() - t0 };
  }

  const upstream = await execAsync("git", [
    "-C",
    absPath,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (!upstream.ok) {
    return { path: absPath, bucket: "no-upstream", durationMs: performance.now() - t0 };
  }

  const ahead = await execAsync("git", ["-C", absPath, "rev-list", "--count", "@{u}..HEAD"]);
  const aheadCount = Number.parseInt((ahead.stdout || "0").trim(), 10);
  const bucket: Bucket = aheadCount > 0 ? "ahead" : "clean";
  return { path: absPath, bucket, durationMs: performance.now() - t0 };
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? process.cwd());
  const concurrency = Number.parseInt(process.env.CHI_WORKSPACE_PARALLEL ?? "8", 10);
  const depth = Number.parseInt(process.env.CHI_WORKSPACE_DEPTH ?? "3", 10);

  console.log(`workspace:   ${root}`);
  console.log(`concurrency: ${concurrency}`);
  console.log(`max-depth:   ${depth}`);

  const tDiscoverStart = performance.now();
  const d = discover(root, depth);
  const tDiscover = performance.now() - tDiscoverStart;
  console.log(
    `\ndiscovered:  ${d.repos.length} repos · ${d.visited} dirs visited · ${tDiscover.toFixed(0)}ms${d.capped ? " (HARD-CAPPED)" : ""}`,
  );

  if (d.repos.length === 0) {
    console.log("nothing to triage; exiting.");
    return;
  }

  const tTriageStart = performance.now();
  const results = await pool(d.repos, async (r) => triage(r.absPath), concurrency);
  const tTriage = performance.now() - tTriageStart;

  const buckets: Record<Bucket, number> = {
    clean: 0,
    dirty: 0,
    ahead: 0,
    "no-upstream": 0,
    invalid: 0,
  };
  let maxRepoMs = 0;
  let totalRepoMs = 0;
  for (const r of results) {
    buckets[r.bucket] += 1;
    totalRepoMs += r.durationMs;
    if (r.durationMs > maxRepoMs) maxRepoMs = r.durationMs;
  }

  const total = tDiscover + tTriage;
  console.log(`\ntriage:      ${tTriage.toFixed(0)}ms wall-clock`);
  console.log(`             clean:       ${buckets.clean}`);
  console.log(`             dirty:       ${buckets.dirty}`);
  console.log(`             ahead:       ${buckets.ahead}`);
  console.log(`             no-upstream: ${buckets["no-upstream"]}`);
  console.log(`             invalid:     ${buckets.invalid}`);

  console.log(`\nslowest repo:           ${maxRepoMs.toFixed(0)}ms`);
  console.log(`avg per repo:           ${(totalRepoMs / results.length).toFixed(0)}ms`);
  console.log(`sum of per-repo time:   ${totalRepoMs.toFixed(0)}ms (serial-equivalent)`);
  console.log(`speedup vs serial:      ${(totalRepoMs / tTriage).toFixed(2)}x`);
  console.log(`total (discover+triage): ${total.toFixed(0)}ms`);

  // H1 verdict
  const cleanRatio = buckets.clean / results.length;
  console.log("");
  if (results.length >= 100 && cleanRatio >= 0.8) {
    const verdict = total <= 10_000 ? "PASS" : "FAIL";
    console.log(`H1 verdict (≥100 repos, ≥80% clean, ≤10s): ${verdict}`);
    console.log(`   target: 10000ms · actual: ${total.toFixed(0)}ms · clean ratio: ${(cleanRatio * 100).toFixed(0)}%`);
  } else {
    console.log(`H1 not testable on this workspace (need ≥100 repos & ≥80% clean; got ${results.length} & ${(cleanRatio * 100).toFixed(0)}%).`);
  }

  // List dirty/ahead/invalid repos for sanity check
  const interesting = results.filter((r) => r.bucket !== "clean" && r.bucket !== "no-upstream");
  if (interesting.length > 0 && interesting.length <= 20) {
    console.log("\nnon-clean repos:");
    for (const r of interesting) {
      console.log(`  ${r.bucket.padEnd(8)} ${r.path}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
