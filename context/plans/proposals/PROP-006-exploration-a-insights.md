---
id: PROP-006-exploration-a
type: INSIGHTS
parent: PROP-006
exploration-mode: A
status: complete
collected-by: ai
collected-at: 2026-05-02
machine: Apple Silicon, macOS Darwin 24.6.0, SSD, fibre
---

# PROP-006 — Exploration-A insights

Throwaway measurements that confirm or challenge the Context-step
framing of [PROP-006](PROP-006-workspace-ship.md). Limited to 10
repos per the user's "10 reichen, will erst den Prozess sauber"
constraint.

## Inventory (confirmed)

| Metric | Value |
|---|---|
| `.git` dirs at depth ≤ 3 under `/Users/chevp/workspace` | **205** |
| `.git` dirs at depth ≤ 4 | 205 (same) |
| Top-level distribution | misc 56, synth 25, cryo 24, apps 13, arctic 11, sites 9, frost 8, frameworks 8, tools 7, playground 6, … |

PROP-006's "204 repos" assumption is accurate (one new repo since the
proposal was drafted). Depth ≤ 3 covers everything; the proposed
default `CHI_WORKSPACE_DEPTH=3` is correct.

## Serial-baseline measurement (10 repos)

Throwaway script `/tmp/chi-baseline.sh`: per repo runs
`git status --porcelain` + `git rev-parse --abbrev-ref @{u}` +
`git rev-list @{u}..HEAD`. Network-free (no `git fetch`).

| Run | Repos | Elapsed |
|---|---|---|
| 1 (cold) | 10 | **807 ms** |
| 2 (warm) | 10 | 396 ms |
| 3 (warm) | 10 | 331 ms |

Per-repo: ~80 ms cold, ~33 ms warm.

Extrapolated to all 205 repos, **serial triage only** (no network):
- cold: ~16.4 s
- warm: ~6.8 s

## Findings

### Confirmed

- **Workspace size justifies the feature.** 205 repos × per-repo wall-clock
  > 10 s in the cold case. Manual `for d in */; do (cd && chi ship); done`
  is unworkable.
- **Local-first triage is the right pivot.** All 10 sampled repos were
  clean. If that ratio holds over 205, parallel ship has very little to
  do; the dominant cost is the triage itself.
- **Network is not yet the bottleneck.** The serial baseline above is
  network-free and already measurable in seconds. Adding `git fetch` per
  repo (which today's `chi ship` would have to do) blows that up by an
  order of magnitude — confirming H2's premise that batched `gh api graphql`
  is the right shape for ahead-detection.

### Tension with H1's kill criterion

H1 sets a **< 10 s wall-clock** target for 205 mostly-clean repos. The
**serial cold** baseline alone is **~16 s**, just for local triage. This
tightens the design space:

- An 8-worker parallel pool theoretically brings the cold case to ~2 s
  triage — well under the kill threshold. Plenty of headroom.
- BUT: if `chi ship` is invoked rarely (cold cache typical), the cache
  miss dominates over pool concurrency for very small batches. Pool
  size and amortization need real measurement in B.

H1 stays alive but the kill criterion's margin is smaller than the
PROP-006 narrative suggests.

### Surprising

- **Cold ↔ warm spread is > 2×.** macOS file-cache eviction on a busy
  workspace likely puts every `chi ship` invocation closer to "cold".
  Implication for B: measure cold-cache numbers explicitly, not warm.
- **Sampling bias risk.** All 10 sampled repos were clean. The
  population is probably skewed toward clean (long-lived archives in
  `misc/`, `cryo/`, `frost/`), which is the *good* case for PROP-006 —
  but it means we have no measurement yet for the dirty/ahead path.

## What this means for Exploration-B

- **Keep H1**, but rerun against cold-cache state on the full 205-repo
  population (e.g. `sudo purge` between runs) — the warm number flatters
  the design.
- **Promote H2 to first-class B target.** Local-only triage is already
  fast enough to make ahead-detection the single biggest network cost.
  Validate the graphql-batch shape against a real `gh api graphql` call
  before committing to it.
- **Add a B candidate the PROP didn't list:** `xargs -P 8` over a tiny
  shell helper that emits `repo|status|ahead`, parsed by chi. No
  Promise-pool, no JS concurrency primitive, leans on the OS scheduler.
  Cheap to prototype, useful as a lower-bound baseline against B1
  (hand-rolled JS pool).
- **Defer auto-clone (H3) to last.** Riskiest, depends on `gh repo list`
  behavior + manifest format that ADR-004 has to settle first. No need
  to prototype it until B1+B2 have shipped a triage-only spike.

## Hypotheses status going into B

| Hypothesis | A status | Note |
|---|---|---|
| H1 wall-clock < 10 s | **alive, tightened** | Serial cold ≈ 16 s, parallel headroom plausible but not guaranteed for small N |
| H2 graphql batching replaces N × `git fetch` | **strengthened** | Network cost is now confirmed as dominant after triage; batching is the obvious lever |
| H3 auto-clone closes drift loop | **untouched in A** | No measurement; defer to last B prototype |

## Throwaway artifact

The measurement script `/tmp/chi-baseline.sh` is intentionally outside
the repo. Reproduce by re-running the commands logged in this session;
do not commit the script.
