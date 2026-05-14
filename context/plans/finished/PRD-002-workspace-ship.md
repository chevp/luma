---
id: PRD-002
type: PRD
status: done
proposed-by: ai
proposed-at: 2026-05-02
g2-approved-by: chevp
g2-approved-at: 2026-05-02
g2-evidence: insights-PRD-002.md (H1 PASS, H2 PASS, H3 deferred to G3)
g3-approved-by: chevp
g3-approved-at: 2026-05-02
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-02
completed-at: 2026-05-02
supersedes: —
implements: PROP-006
implemented-by: PR #6
depends-on: ADR-004
exploration-mode: true
evidence:
  hypothesis: |
    For a workspace of N≈200 sibling git repos where ≥90% are clean at any
    given moment, total wall-clock for `chi ship` is dominated by network
    round-trips (git fetch / gh pr list). A local-first triage that filters
    out clean repos with zero network calls, combined with a bounded parallel
    pool of size 8 over the remainder and one batched `gh api graphql` call
    for ahead/PR detection, will reduce wall-clock from minutes (serial) to
    under 10 seconds on the reference machine.
  result: |
    Pending implementation. Reference measurement to be captured during EXP
    prototype against /Users/chevp/workspace/ in a known-clean state, then
    again with a synthetic dirty/ahead subset of 10 repos. See acceptance
    criteria 9 and 10.
  reasoning: |
    `git status --porcelain` is purely local and runs in 5–20ms per repo.
    `git rev-list @{u}..HEAD` is also local once a fetch has happened — and
    we explicitly do not fetch during triage; we trust the prior local state
    and only confirm via the batched gh GraphQL call for repos that look
    clean-locally-but-might-be-ahead-on-origin. Parallelism is bounded at 8
    to avoid thrashing macOS file descriptor limits and to keep stderr
    output legible for the user.
---

# PRD-002 — Workspace-aware `chi ship`

Implements PROP-006. Depends on ADR-004 (workspace discovery + manifest +
concurrency primitive).

## Goal

Running `chi ship` from a directory **without** `.git` (e.g.
`/Users/chevp/workspace/`) ships every sibling git repo found beneath it,
auto-clones missing repos listed in `gh repo list`, and completes the
common case (mostly-clean workspace) in under 10 seconds wall-clock.

Single-repo behavior is unchanged — `chi ship` from inside a `.git` repo
must produce identical output and exit code as today.

## In scope

| Area | Files |
|---|---|
| Dispatch guard | [src/commands/ship.ts](../../src/commands/ship.ts) — early branch when `!isInsideRepo()` |
| Workspace pipeline | `src/commands/ship-workspace.ts` (new) |
| Discovery | `src/workspace/discover.ts` (new) — BFS walker per ADR-004 |
| Manifest | `src/workspace/manifest.ts` (new) — line parser per ADR-004 |
| Concurrency | `src/concurrency.ts` (new) — `pool()` per ADR-004 |
| gh batch query | `src/gh/graphql.ts` (new) — minimal `gh api graphql` wrapper |
| Auto-clone phase | inside `ship-workspace.ts`, gated by `CHI_WORKSPACE_AUTOCLONE` |
| Provider lock | [src/provider/index.ts](../../src/provider/index.ts) — single-slot queue around `providerSmartGenerate`, sized by `CHI_PROVIDER_PARALLEL` (default 1) |
| Doctor integration | [src/commands/doctor.ts](../../src/commands/doctor.ts) — new `doctor workspace` target |
| Help text | [src/commands/ship.ts](../../src/commands/ship.ts) HELP — append workspace mode section |

## Out of scope

- Workspace-wide flow mode (one branch across N repos) — separate PROP.
- Workspace mode for `chi status`, `chi commit`, `chi done` — separate PROPs.
- Pull-request-aware orchestration (e.g. only ship repos whose PR is approved)
  — separate PROP.
- Conflict resolution during workspace pull — intersects PROP-003; out of scope
  here, surfacing per-repo conflicts as failures and continuing.
- Cross-repo dependency ordering (e.g. ship lib before consumer) — out of
  scope; ship order is discovery order.

## Design

### Phase 0: Dispatch (in `ship.ts`)

```
if (!isInsideRepo()) {
  return shipWorkspaceRun(argv);   // delegate, return its exit code
}
// existing single-repo logic unchanged
```

`shipWorkspaceRun(argv)` lives in `ship-workspace.ts`. The flag surface for
workspace mode is small: `--dry-run` (Phase 1+2 only, no commit/push),
`--no-clone` (skip Phase 1 clone), `-h/--help`.

### Phase 1: Discovery + auto-clone

1. Walk per ADR-004 → `localRepos: { absPath, slug? }[]`. The slug is parsed
   from `git -C <path> config remote.origin.url` if present.
2. Read manifest at `<root>/.chi-workspace` per ADR-004 →
   `manifest: Map<slug, subpath>`.
3. If `CHI_WORKSPACE_AUTOCLONE !== "0"` and `--no-clone` not set:
   - `gh repo list <user> --limit 1000 --json nameWithOwner,sshUrl` →
     `remoteRepos: { slug, sshUrl }[]`. The `<user>` is taken from
     `gh api user --jq .login` cached for the run.
   - For each `remote` not present in `localRepos`:
     - If `manifest.has(slug)` → `git clone <sshUrl> <root>/<subpath>` in the
       parallel pool.
     - Else → record as "unmapped" warning; skip.
4. Re-walk (cheap; just discovery) to pick up any cloned repos.

### Phase 2: Local-first triage (parallel)

`pool(localRepos, async (r) => triage(r), 8)` where `triage` runs:

- `git -C r status --porcelain` → if non-empty, bucket = `dirty`.
- Else `git -C r rev-list @{u}..HEAD --count` → if `> 0`, bucket = `ahead`.
- Else if no upstream → bucket = `no-upstream` (skipped, warned).
- Else → bucket = `clean` (skipped silently).

No network calls here. The `clean` bucket is the dominant case and exits in
the local-only time of the slowest worker × ceil(N / 8).

### Phase 3: Batched gh probe (one round-trip)

For repos in `clean` bucket, we trust local state; *no* gh call.

For repos in `ahead` bucket *and* `dirty` bucket, we do **one** `gh api
graphql` call (chunked at 50/req if N > 50) that fetches:

```graphql
query($q1: String!, $q2: String!, ...) {
  r1: repository(owner: ..., name: ...) {
    defaultBranchRef { target { oid } }
    pullRequests(headRefName: "<branch>", first: 1, states: OPEN) {
      nodes { number url isDraft }
    }
  }
  r2: ...
}
```

Result feeds the per-repo ship to know (a) whether origin moved since the
last local fetch, and (b) whether a PR already exists for the current
branch — replacing N×`gh pr list` calls.

### Phase 4: Ship execution

Two sub-phases per the PROP-006 push-serialization decision:

- **4a (parallel, pool=8):** for each non-clean repo, run the existing
  single-repo ship steps **up to and excluding** `git push`: pull --ff-only,
  commit, prepare PR title/body. This is the throughput-heavy part.
- **4b (serial, with progress):** push each repo one at a time with an
  inline progress line `[k/N] <repo> → pushing...`. In flow mode, `gh pr
  create --draft` runs here too (after push). Serial because credential
  helpers and `gh` auth do not interleave cleanly across processes.

**Provider call serialization (R3 mitigation).** Inside Phase 4a, the per-repo
work calls `providerSmartGenerate` for commit-message generation. Eight
concurrent Claude API calls saturate per-account rate limits within ~3 seconds
on the reference workspace. Solution: route every `providerSmartGenerate`
invocation through a **single-slot queue** in
[src/provider/index.ts](../../src/provider/index.ts) so commit prep
parallelizes everywhere *except* the LLM call itself. Tunable via
`CHI_PROVIDER_PARALLEL=N` (default 1) for users on accounts/providers that
scale (local Ollama on multi-GPU, Anthropic Tier 4+, etc.). See ADR-004
§4 for the design.

### Output format

Three sections:

```
── workspace: /Users/chevp/workspace ──
  discovered: 204 repos · 2 cloned · 1 unmapped warning

── triage ──
  clean:    187   skipped
  ahead:      9   will push
  dirty:      8   will commit + push

── shipping (8 dirty / 9 ahead) ──
  [1/17] synth/synth-game        committed → pushed (PR #142 updated)
  [2/17] frameworks/foo          pushed
  ...

done in 7.3s · 0 failed
```

Failed repos exit with code 1 and are listed at the bottom; one failed repo
does not abort the run.

## Acceptance criteria

1. `npm run build` succeeds with no TS errors.
2. `chi ship` inside a single repo (e.g. `cd chi && chi ship`) produces
   byte-identical stdout/stderr and same exit code as before this PRD on a
   golden test repo.
3. `chi ship` from `/Users/chevp/workspace/` (no `.git`) detects workspace
   mode, prints the workspace banner, and runs Phases 1–4.
4. `chi ship --dry-run` from a workspace runs Phases 1–3, prints the triage
   table, and exits 0 without committing or pushing.
5. `chi ship --no-clone` skips Phase 1 clone but still discovers + triages +
   ships existing repos.
6. A manifest with parse errors surfaces line-numbered diagnostics on stderr,
   and the run aborts with exit code 2 (config error, distinct from per-repo
   failure).
7. With one repo deliberately dirty + ahead, the triage output reflects it
   correctly and only that repo is shipped.
8. `gh api graphql` is called **at most** `ceil(N/50)` times per run, where
   N is the size of `dirty ∪ ahead`. Verified by a stub `gh` fixture that
   counts invocations.
9. Wall-clock: workspace with 200 mostly-clean repos completes in **≤10s**
   on the reference machine (M-series Mac, warm filesystem cache).
10. Wall-clock: workspace with 10 dirty + 190 clean completes in **≤30s**
    (push phase serial; expect ~1.5s/repo network for SSH push).
11. `chi doctor workspace` lists: discovered count, unmapped GH repos, stale
    manifest entries, repos with no upstream.
12. A failure in one repo (e.g. push rejected) does not abort the run; the
    final report names it; exit code = 1.
13. Provider serialization holds: with `CHI_PROVIDER_PARALLEL=1` (default),
    a workspace with 8 dirty repos sees provider calls strictly sequential
    (verifiable by an instrumented stub provider that records call timestamps
    and asserts `call[k+1].start ≥ call[k].end`).
14. Single-repo `chi commit` (no workspace involved) shows no measurable
    latency regression from the provider lock — the lock is uncontended in
    that path.

## Challenger

Mandatory pre-G2 critique. Each failure mode names: observable breakage,
cheapest detection signal, response.

### Top-3 failure modes

Mapped directly from PROP-006 R1–R3 (R4 — credential-prompt deadlock — is
resolved upstream by the serial-with-progress push decision and is not
re-litigated here).

1. **Partial-clone state poisons re-runs (PROP-006 R1).**
   - Breakage: Phase 1 clones repo X but git aborts mid-clone (network
     blip, quota). The directory exists but `.git/HEAD` is missing or the
     working tree is empty. Phase 2 triage on X fails, every subsequent
     run repeats the failure.
   - Detection: `git -C X rev-parse --is-inside-work-tree` returns nonzero
     on a directory that exists.
   - Response: Phase 1 clones into `<subpath>.cloning` first and atomically
     `mv` to `<subpath>` only on success; on failure, remove the temp dir.
     Phase 2 still defends in depth — detects "git dir present but not a
     valid repo" and surfaces the path with a `chi doctor workspace
     --repair` hint (repair command lands in a future PROP).

2. **Manifest drift after GitHub repo rename (PROP-006 R2).**
   - Breakage: `chevp/synth-game` renamed to `chevp/synth-arena` upstream.
     Manifest still points the old slug to `synth/synth-game`. Phase 1 sees
     `chevp/synth-arena` as "missing locally" and (no manifest entry)
     warns "unmapped". User confused — the repo *is* there, just under the
     old name.
   - Detection: a manifest slug that resolves to neither a local dir's
     `remote.origin.url` nor a GitHub repo.
   - Response: discovery walks local first and matches by
     `remote.origin.url`, not slug; only unmatched manifest entries trigger
     auto-clone. `chi doctor workspace` flags slug-vs-path mismatches
     explicitly. The ship run does not auto-rename; manual manifest fix
     required.

3. **Provider rate-limit saturation under parallel commit prep (PROP-006 R3).**
   - Breakage: Phase 4a calls `providerSmartGenerate` for commit-message
     generation per repo. Eight concurrent Claude API calls hit the
     per-account RPS limit within ~3 seconds on a 200-repo workspace; some
     repos get 429 responses, their commit step fails, and the user sees
     a flurry of "rate limited" errors with no obvious recovery path.
   - Detection: provider returns HTTP 429 (Claude/Copilot) or sustained
     latency spikes >5s on local Ollama indicating GPU contention.
   - Response: serialize *only the provider call* through a single-slot
     queue in [src/provider/index.ts](../../src/provider/index.ts); the
     rest of Phase 4a (git operations, file I/O) stays parallel. Tunable
     via `CHI_PROVIDER_PARALLEL=N`. See ADR-004 §4.

### Two alternatives

**Alt A: separate `chi workspace ship` subcommand instead of auto-detect.**
- Sketch: `chi workspace <verb>` namespace; `chi ship` stays single-repo only.
- Rejected because: user explicitly chose auto-detect (faster muscle memory,
  one command to remember). Condition to reopen: if auto-detect produces
  surprising failures in repos with unusual layouts (e.g. a `.git` worktree
  pointer file at a non-root path) where the `isInsideRepo()` heuristic
  misfires. Then split the namespace.

**Alt B: skip `gh api graphql`; use `git ls-remote` per repo for ahead-detection.**
- Sketch: each non-clean repo runs `git ls-remote origin HEAD` in the parallel
  pool. No GraphQL.
- Rejected because: still N network calls instead of 1, and it doesn't tell
  us about existing PRs (we'd still need `gh pr list` per repo for flow mode).
  GraphQL collapses both. Condition to reopen: if `gh api graphql` quota
  becomes a real constraint, or if `gh` is unavailable on a target machine.

### Counter-argument

The strongest argument against this PRD is: **manifest curation is the same
problem as the one we're solving, just moved up a layer.** The user has 200+
repos and needs a reliable way to know which exist where. We're saying "fine,
write a manifest with 200+ lines." If they can do that, they can also `git
clone` each repo manually once and not need auto-clone.

This is genuine. The defense: the manifest is a **one-time** write that
makes every subsequent operation deterministic, and `chi doctor workspace`
can generate the initial draft from the existing folder layout (`<existing
remote.origin.url's slug> = <relative path>`) so the user only edits, not
authors. The auto-clone phase pays off when **new** repos get created on
GitHub later — adding a single manifest line and re-running `chi ship` is
strictly cheaper than the user noticing and cloning manually.

## Kill criteria

Abandon and revisit if any of:

- Acceptance criterion 9 (200 mostly-clean ≤10s) cannot be met after
  reasonable optimization — likely indicates a wrong abstraction (probably
  Phase 2 triage shelling out to git per repo is too expensive; would need
  a libgit2-style native binding which violates ADR-003).
- `gh api graphql` proves unreliable or rate-limited at our usage shape on
  realistic accounts (>1k repos). Fallback: drop GraphQL, accept the slower
  per-repo `git ls-remote`, document the regression.
- Auto-clone phase causes data loss (e.g. clones over an existing
  non-tracked directory). Hard kill — remove auto-clone entirely, leave
  workspace mode as triage+ship only.
- The auto-detect dispatch (`!isInsideRepo()` → workspace mode) misfires in
  >5% of real invocations, surprising users into running workspace mode
  when they meant single-repo. Fallback: require an explicit
  `--workspace` flag (Alt A, the rejected alternative).

## Acceptance evidence to capture during EXP

- Wall-clock numbers from criteria 9 + 10, posted in `insights.md` after
  prototype.
- `gh api graphql` call count from criterion 8.
- Output transcript of a deliberate-failure scenario (criterion 12) showing
  graceful continuation.

## Naming

- Marker: none required; workspace mode is stateless per invocation.
- Manifest: `<workspace-root>/.chi-workspace` (literal name; no leading
  underscore so it sorts with other dotfiles in `ls -la`).
- Env vars: `CHI_WORKSPACE_PARALLEL` (int, default 8),
  `CHI_WORKSPACE_DEPTH` (int, default 3), `CHI_WORKSPACE_AUTOCLONE`
  (`0` to disable, default on).
