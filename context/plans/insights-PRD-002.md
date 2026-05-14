---
id: insights-PRD-002
type: insights
implements: PRD-002
captured-at: 2026-05-02
captured-by: ai
machine: Apple Silicon (chevp's primary), warm and cold filesystem cache
workspace: /Users/chevp/workspace (205 repos)
---

# Insights for PRD-002 — Workspace-aware `chi ship`

G2 Exploration evidence. Spikes live under [src/spikes/](../../src/spikes/);
they are not wired into the dispatcher and exist only to produce numbers.

## H1 — Triage + parallelism collapses wall-clock for mostly-clean workspaces

**Verdict: PASS.**

Spike: [src/spikes/triage-spike.ts](../../src/spikes/triage-spike.ts).

| Run | Concurrency | Wall-clock | Notes |
|---|---|---|---|
| Cold cache | 8 | 4747 ms | One outlier repo took 4704 ms (cold .git fetch from disk); rest finished in <500 ms. |
| Warm cache | 8 | 1645 ms | Steady-state. |
| Warm cache | 4 | 2265 ms | Half-saturated; visible regression. |
| Warm cache | 16 | 1645 ms | No improvement over 8 — CPU/IO saturated at 8. |

Distribution on the 205-repo workspace: 191 clean / 11 dirty / 1 ahead /
2 no-upstream / 0 invalid. Clean ratio 93%. Per-repo work averages 134 ms;
sum-of-per-repo is 27.5 s, so concurrency=8 yields 5.85× speedup over a
naive serial loop.

Conclusion: H1 target (≤10 s for ≥100 repos at ≥80% clean) is met with a
factor-of-2 margin even on cold cache. Default `CHI_WORKSPACE_PARALLEL=8`
is correct — increasing to 16 does not help, decreasing to 4 hurts.

## H2 — `gh api graphql` batching replaces N × `git fetch`

**Verdict: PASS.**

Spike: [src/spikes/graphql-spike.ts](../../src/spikes/graphql-spike.ts).

12 repos resolved via 1 GraphQL call in 1225 ms total wall-clock. Query
shape (`defaultBranchRef.target.oid` + `pullRequests(first:1, states:OPEN)`)
returns the data PRD-002 Phase 3 needs:

- `defaultBranchRef.target.oid` → compare with local `HEAD`'s `rev-parse`
  to detect "ahead on origin" without `git fetch`.
- `pullRequests.nodes[0]` → tells flow-mode whether a PR already exists
  for the current branch.

For the 200-repo workspace, projecting to 4 batches × ~1.2 s ≈ 5 s of gh
overhead in the worst case where every repo is non-clean. The common case
(most repos clean → skipped in Phase 2) keeps gh calls near zero.

Edge case observed: GraphQL returns partial data with per-field errors
(e.g. `NOT_FOUND` for a renamed repo) rather than failing the whole query.
PRD-002's manifest-drift handling (R2) maps cleanly onto this — the spike
already logs each per-field error and continues.

## H3 — Manifest-driven auto-clone closes the drift loop

**Verdict: deferred to G3 fault-injection tests.**

H3's failure rate is dominated by user network conditions and one-off
git/gh edge cases rather than chi's design choice. The spike that would
"validate" H3 is essentially `git clone <url> <tmpdir>` — testing git, not
chi. The PRD-002 R1 mitigation (clone into `<subpath>.cloning`, atomic
`mv` on success) is the actual design decision; verifying it requires
deliberate fault injection (kill mid-clone, full disk, network blip)
which belongs in G3 acceptance testing, not G2 spikes.

What G2 *did* validate: the inputs to auto-clone exist and are cheap.
`gh repo list chevp --limit 1000 --json nameWithOwner` returns the
authoritative remote set in <2 s on the test account; local discovery
runs in 38 ms. The set-difference is a hash-table operation. The "expensive"
part of auto-clone is the cloning itself, which is git's responsibility.

G3 will add a fault-injection harness (`src/spikes/clone-faults.ts` or a
real test file) before claiming H3 PASS.

## Side findings

1. **Cold-cache outlier dominates wall-clock.** First-run included one repo
   that took 4.7 s (likely a large `.git` not in the OS page cache).
   Mitigation: nothing in chi can fix this — the FS does. Worth surfacing
   in user-facing output as a hint ("first run is slow; subsequent runs
   are warm-cache fast") rather than treating as a bug.

2. **`noUncheckedIndexedAccess` is friction-free.** The pool primitive uses
   `items[i]!` once; everywhere else array access is gated by length checks
   already present in the loop structure. The strict-mode setting paid for
   itself by catching one off-by-one in `discover.ts` during authoring.

3. **Discovery skip list is sufficient on the real workspace.** 205 repos
   discovered visiting only 229 directories total (24 non-repo
   intermediates). The hand-curated skip list (`node_modules`, `.git`,
   `dist`, ...) does not need expansion for the current workspace; if a
   user's layout differs, doctor's "high directory count" warning will
   surface it.

## What's blocked / next

G2 evidence captured for H1 and H2. H3 is structurally a G3 concern.

Next decisions for human approval before G3:
- Promote PRD-002 to `status: approved` and start production.
- Or run an additional spike: `gh repo list chevp` ∖ `local discovery` →
  surface the actual list of "missing locally" repos to validate that the
  manifest design holds against real data (cheap — ~5 minutes of work).
- Or revisit ADR-004 if any of the spike findings invalidate a decision.
  (None do, in this author's reading.)
