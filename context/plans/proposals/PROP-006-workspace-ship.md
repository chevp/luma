---
id: PROP-006
type: PROP
status: exploration
proposed-by: ai
proposed-at: 2026-05-02
g1-approved-by: chevp
g1-approved-at: 2026-05-02
evidence-g1:
  hypothesis: Auto-detect workspace mode + triage + parallelism + gh-graphql
              batching collapse `chi ship` wall-clock from minutes to seconds
              for the mostly-clean 200-repo case, and a manifest-driven
              auto-clone closes the "exists on GitHub, missing locally"
              drift loop.
  result:     Three hypotheses formulated with concrete tests + kill criteria
              (H1 wall-clock <10s, H2 graphql round-trips O(N/50), H3 auto-
              clone failure rate <5%). Three expensive risks named with
              mitigations (R1 partial-clone, R2 manifest-drift, R3 LLM
              rate-limit). R4 (credential-prompt) resolved upstream via
              serial-with-progress push decision. ADR-004 scope sketched
              (discovery, manifest format, concurrency primitive, env gates).
              Out-of-scope items recorded.
  reasoning:  G1 requires problem framed + risks named + scope confirmed —
              not yet code or prototypes. All three are present and
              specific. Architectural questions are surfaced with plausible
              answers, deferred to ADR-004 in Exploration.
---

# PROP-006 — Workspace-aware `chi ship` (auto-detect, parallel, gh-batched)

## What

When `chi ship` is run from a directory **without `.git`**, treat it as a
workspace root and ship every git repo found beneath it (default depth ≤ 3).

Three-phase pipeline:

1. **Discovery** — walk the tree, collect every `.git` dir. Compare against the
   "should-exist" set from `gh repo list <user> --limit 1000` and clone any
   missing repos into the path resolved by the manifest.
2. **Local-first triage** — for each repo, run `git status --porcelain` +
   `git rev-list @{u}..HEAD` in a parallel pool. Buckets: `clean`, `dirty`,
   `ahead`. Skip `clean` entirely (no network).
3. **Parallel ship** — bounded worker pool (default 8) runs the existing
   single-repo ship logic only on `dirty` ∪ `ahead`. PR creation in flow mode
   reuses one `gh api graphql` round-trip per batch instead of N×`gh pr list`.

Single-repo behavior (`.git` present in cwd) is unchanged.

## Why

- `/Users/chevp/workspace/` has 204 git repos across category folders. `chi ship`
  today only walks `.gitmodules` ([src/commands/ship.ts:36](../../../src/commands/ship.ts#L36))
  and aborts at workspace root with "not a git repository".
- Serial × 200 repos × per-repo network latency = unusable. The dominant cost
  is round-trips, not compute, so parallelism + batched `gh api graphql`
  collapse the wall-clock from minutes to seconds for the common (mostly-clean)
  case.
- Manual repo cloning across 200+ repos drifts: a repo created on GitHub but
  never cloned locally is invisible to every workflow until somebody notices.
  Auto-clone closes that loop.

## Notes

- **New file:** `src/commands/ship-workspace.ts`. `ship.ts` gains a single
  guard: if `!isInsideRepo()`, delegate to `ship-workspace.run(argv)`.
- **Manifest:** `<workspace-root>/.chi-workspace` — minimal line-based format
  (no parser dep), one mapping per line: `<gh-repo-slug> = <local-subpath>`.
  Repos without a manifest entry surface as a doctor warning ("unmapped:
  chevp/foo — add to .chi-workspace") and are NOT auto-cloned.
- **Concurrency:** hand-rolled `Promise` pool in `src/concurrency.ts` (no dep,
  matches ADR-003). Default 8, override via `CHI_WORKSPACE_PARALLEL`.
- **gh batching:** one `gh api graphql` call per ≤50 repos pulls
  `defaultBranchRef.target.oid` + open PR head refs; replaces N×`git fetch`
  for the ahead-detection pass.
- **Push phase serialization:** parallel `git push` can collide on credential
  prompts. **Decision (chevp, 2026-05-02):** commit phase parallel, push phase
  **serial-with-progress** — predictable, no auth-prompt deadlock, progress
  output stays readable. The fully-parallel SSH-only variant is rejected for
  now; revisit only if push wall-clock becomes the dominant cost in
  measurements.
- **Behavior gates:**
  - `CHI_WORKSPACE_PARALLEL=N` (default 8)
  - `CHI_WORKSPACE_DEPTH=N` (default 3)
  - `CHI_WORKSPACE_AUTOCLONE=0` to opt out of clone phase
- **Out of scope** (future PROPs):
  - Workspace-wide flow mode (one branch across N repos)
  - `chi status` workspace mode
  - `chi doctor` workspace mode (manifest validation, orphaned dirs)
  - Workspace-wide rebase/conflict handling (intersects PROP-003)

## Hypotheses

**H1 — Triage + parallelism collapses wall-clock for mostly-clean workspaces.**
- Test: 200-repo synthetic workspace, ~190 clean + ~10 dirty on reference
  machine (Apple Silicon, SSD, fibre). Compare `chi ship` (workspace mode)
  against the serial baseline `for d in */; do (cd "$d" && chi ship); done`.
- Kill criterion: parallel variant is < 2× faster than serial, OR exceeds
  10 s wall-clock for the mostly-clean case. Either redesign (likely the
  bottleneck is `gh`/`git fetch`, not the worker pool) or downscope to
  triage-only.

**H2 — `gh api graphql` batching replaces N × `git fetch` for ahead-detection.**
- Test: 100-repo workspace, all clean locally, 30 ahead on remote. Count
  network round-trips and wall-clock for ahead-detection alone. Compare
  against `git fetch --all` per repo.
- Kill criterion: graphql query cannot return `defaultBranchRef.target.oid`
  + open-PR head refs in one round-trip per ≤ 50 repos (permission scopes,
  schema drift, query-cost limits). Fall back to parallel `git fetch`.

**H3 — Manifest-driven auto-clone closes the "exists on GitHub, missing
locally" drift loop.**
- Test: Add a manifest entry for a repo that doesn't exist locally. Run
  `chi ship` from workspace root. Repo is cloned into the manifest-mapped
  path; subsequent run treats it as a normal local repo.
- Kill criterion: > 5 % of auto-clones fail in a 200-repo test pass
  (auth, recursion, path collision). Demote auto-clone from default-on to
  opt-in via `CHI_WORKSPACE_AUTOCLONE=1`.

## Risks

**R1 — Partial-clone state on mid-flight failure (top-3, expensive).**
Auto-clone interrupted mid-stream (network drop, quota) leaves a half-formed
`.git` directory. Next run sees a "real repo" and triages it incorrectly.
Mitigation: clone into a temp dir + atomic `mv` only on success; on failure,
remove the temp dir. Doctor warns on stray `*.cloning` siblings.

**R2 — Manifest drift (top-3, expensive).**
User manually moves or renames a local repo. Manifest still points at the
old path → discovery thinks the repo is missing, auto-clone re-creates it,
two local copies diverge. Mitigation: discovery walks local first, matches
`remote.origin.url` ↔ `gh-slug`; only unmatched manifest entries trigger
auto-clone. `chi doctor workspace` (future) flags slug-vs-path mismatches.

**R3 — Concurrent LLM calls saturate the provider (top-3, expensive).**
`chi ship` invokes the active provider for commit-message generation per
repo. A pool of 8 concurrent runs hits provider rate limits (Claude API)
or single-GPU contention (local Ollama). Mitigation: parallel commit phase,
but route every `providerSmartGenerate` call through a single-slot queue in
[src/provider/index.ts](../../../src/provider/index.ts); document via
`CHI_PROVIDER_PARALLEL=N` for users who know their provider scales.

**R4 — Credential-prompt deadlock (mitigated by design).**
Resolved upstream by the serial-with-progress push decision recorded in
*Notes* — listed here for completeness so reviewers don't re-derive it.

## ADR sketch

A new ADR (likely ADR-004 — *workspace discovery & manifest format*) lands
between G1 pass and G2 start. Scope:

- Discovery strategy: local-first (`find -maxdepth N -name .git`) ↔ manifest
  reconciliation. Why local-first: avoids manifest-drift false-positives (R2).
- Manifest format: line-based `<gh-slug> = <local-subpath>`. Why not YAML/JSON:
  preserves zero-runtime-deps (ADR-003); manifest is read-mostly and edited
  by humans, not machines.
- Concurrency primitive: hand-rolled `Promise` pool in `src/concurrency.ts`.
  Why not `p-limit`: ADR-003.
- Behavior gates: `CHI_WORKSPACE_PARALLEL`, `CHI_WORKSPACE_DEPTH`,
  `CHI_WORKSPACE_AUTOCLONE`. Conventions follow existing `CHI_*` prefix.

The ADR is a **G2 prerequisite**, not a G1 prerequisite — G1 only needs
agreement that the architectural questions exist and have plausible answers.
