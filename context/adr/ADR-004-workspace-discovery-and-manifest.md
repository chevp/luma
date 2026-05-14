---
id: ADR-004
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-02
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-02
supersedes: —
---

# ADR-004: Workspace Discovery, Manifest Format, Concurrency, and Provider Serialization

## Status
Accepted.

## Context

PROP-006 (which will promote to PRD-002) introduces workspace-aware behavior to `chi ship`: when invoked from a
directory **without** `.git`, the command treats the cwd as a root containing
many sibling git repos and ships them all. This requires four new patterns
not previously needed in chi:

1. **Workspace discovery semantics** — what is "a workspace"? How deep do we
   look? What do we skip?
2. **Manifest format** — when GitHub reports a repo (`gh repo list`) that does
   not exist locally, where do we clone it? The mapping must be deterministic,
   user-curated, and parseable without dependencies.
3. **Concurrency primitive** — chi has no `Promise` pool today; the workspace
   pipeline needs one.
4. **Provider call serialization** — the workspace pipeline parallelizes git
   operations across N repos, but each repo's commit phase calls into the
   active AI provider. Eight concurrent provider calls saturate the
   rate-limits of every reasonable account/runtime (PROP-006 R3). The git
   pool and the provider pool need different sizes, with different defaults.

Each is a "new pattern" per framework rules and needs an ADR.

## Decision

### 1. Workspace discovery

A directory `D` is a **workspace root** iff:

- `D` itself has **no** `.git` (file or directory).
- At least one descendant within `CHI_WORKSPACE_DEPTH` (default `3`) has a
  `.git`.

Walk rules:

- BFS from `D`, depth ≤ `CHI_WORKSPACE_DEPTH`.
- **Skip** any directory named `node_modules`, `.git`, `dist`, `build`,
  `target`, `.venv`, `__pycache__`. (Hand-curated short list; not generic
  glob — performance over flexibility.)
- **Do not** follow symlinks (avoid cycles; macOS `/Volumes` traps).
- A directory containing `.git` is a **leaf**; do not descend into it
  further (no nested workspace inside a repo).

### 2. Manifest format

File location: `<workspace-root>/.chi-workspace`.

Format: line-based, one mapping per line. **No new parser dependency.**

```
# Comments start with # and are ignored. Blank lines are ignored.
# Format:  <gh-repo-slug> = <local-subpath-relative-to-workspace-root>

chevp/synth-game        = synth/synth-game
chevp/synth-nlp         = synth/synth-nlp
chevp/nuna              = nuna
```

Parsing rules:

- Strip trailing newline; split on first `=`; trim both sides.
- Lines without `=` (after comment/blank stripping) are a parse error and
  surface a doctor warning with `file:line`.
- Subpath must be relative; absolute paths or `..` segments are rejected.
- Slug must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; otherwise rejected.
- A slug may map to **at most one** subpath. Duplicate keys → parse error.
- Unmapped GitHub repos surface as a doctor warning ("unmapped: chevp/foo —
  add to .chi-workspace") and are **not** auto-cloned.

### 3. Concurrency primitive

New file: `src/concurrency.ts`. Single export:

```ts
export async function pool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]>;
```

Behavior:

- Maintains exactly `concurrency` in-flight workers (default 8 at call site).
- Preserves input order in the returned array.
- A worker rejection does **not** cancel siblings; rejections are surfaced as
  rejected promises in the result via a wrapping settled-style helper at the
  call site (chi handles per-repo failures explicitly, not via throws).
- No timeout, no abort signal — call sites use `child_process` timeouts
  directly when needed.

Implementation: index pointer + N awaiters; ~30 lines, zero deps. No
queue/scheduler abstraction; do not generalize.

### 4. Provider call serialization

Independent of the git pool above, all calls into
[src/provider/index.ts](../../src/provider/index.ts)
`providerSmartGenerate()` (and any future top-level provider entry points)
route through a **single-slot async queue** owned by the provider router.

```ts
// src/provider/index.ts (sketch)
let providerLock: Promise<unknown> = Promise.resolve();
export async function providerSmartGenerate(...): Promise<...> {
  const slot = (async () => {
    await providerLock.catch(() => {}); // wait for predecessor, swallow its errors
    return doGenerate(...);
  })();
  providerLock = slot;
  return slot;
}
```

Concurrency for provider calls is governed by `CHI_PROVIDER_PARALLEL` (int,
default `1`). When set to `N>1`, the single lock becomes an N-slot pool
using the same primitive from §3. The default is conservative because:

- Anthropic API free/Pro tiers cap at low double-digit RPS; bursting 8
  concurrent calls produces 429s within seconds.
- `gh copilot` shells out to a per-process auth token shared by all
  invocations — concurrent calls race on token refresh.
- Local Ollama runs one inference at a time per GPU; concurrency just
  queues at the model layer with worse total wall-clock.

Users on Anthropic Tier 4+ or multi-GPU Ollama can opt into
`CHI_PROVIDER_PARALLEL=4` (or more) and recover wall-clock for
commit-heavy workspaces.

The git pool and provider pool are deliberately **separate** primitives:
the git pool default of 8 reflects file-descriptor limits and stderr
legibility; the provider pool default of 1 reflects external service
contract. Conflating them would force one to compromise.

## Alternatives

### Alternative A (discovery): generic recursion with `.gitignore`-style skip rules
- Pros: more flexible, handles unusual layouts.
- Cons: requires a glob/ignore parser → new dep or hand-rolled regex maze; the
  curated skip list covers the actual layout in `/Users/chevp/workspace/`
  empirically. Reject for YAGNI.

### Alternative B (manifest): TOML or YAML
- Pros: standard, extensible (room for per-repo flags later).
- Cons: TOML needs a parser dep (violates ADR-003); YAML reuses chi's minimal
  parser but the workflow YAML parser is intentionally tiny and not designed
  for arbitrary mappings. Reject in favor of the line format.

### Alternative C (manifest): infer mapping from existing folder layout (no manifest)
- Pros: zero curation overhead.
- Cons: ambiguous when a new repo doesn't match any existing prefix (`nuna`
  vs `nuna-content-processor` already disagree on category). User chose
  manifest in the proposal triage explicitly. Reject.

### Alternative D (concurrency): use `Promise.all` with `slice`/batch
- Pros: no helper needed.
- Cons: head-of-line blocking — slow repos in a batch stall the next batch
  even if fast workers are idle. The pool pattern keeps utilization at
  `concurrency` continuously.

### Alternative E (provider serialization): one shared pool, set to 1
- Sketch: drop the separate `CHI_PROVIDER_PARALLEL` env; reuse
  `CHI_WORKSPACE_PARALLEL` for everything; default to 1 globally.
- Pros: one knob, one mental model.
- Cons: serializes git operations too — a 200-repo triage that should run
  in <2s would take >30s. The bottlenecks are different in kind (file
  descriptors / shell legibility vs. external rate limits) and reasonable
  defaults differ by an order of magnitude. Reject in favor of two pools.

### Alternative F (provider serialization): no serialization, document the risk
- Sketch: let users hit 429s; surface the error and let them retry.
- Pros: simplest code; matches "no error handling for scenarios that can't
  happen" — except this scenario *will* happen on every default-config run.
- Cons: makes workspace mode unusable on the default Anthropic tier on day
  one. Reject.

## Consequences

### Positive

- Discovery is O(directories) with a tight skip list; 200 repos walk in <500ms
  on the reference workspace.
- Manifest format is human-readable, diff-friendly, and parses in ~20 lines.
- Concurrency primitive is small enough to audit and fully owned by chi (no
  upstream churn risk).

### Negative

- The skip list will need maintenance as new tooling (`.turbo`, `.next`, etc.)
  appears. Mitigation: doctor warns when discovery walks > N directories,
  hinting at a missing skip rule.
- Manifest demands curation — a fresh GitHub repo is *invisible* to chi until
  the user adds a line. This is intentional (see Alternative C), but users
  will hit it. `chi doctor` must surface unmapped repos clearly.

### Risks

- **Symlink cycles** are guarded by the no-follow rule, but bind mounts on
  macOS could still loop. Mitigation: hard cap on directories visited
  (e.g. 10000) with a clear error.
- **Manifest drift**: a repo renamed on GitHub leaves a stale slug in the
  manifest. Mitigation: doctor flags slugs that resolve neither to a local
  dir nor a GitHub repo.
- **Slug-URL normalization**: `remote.origin.url` appears in at least three
  forms in the wild — SSH (`git@github.com:owner/repo.git`), HTTPS
  (`https://github.com/owner/repo.git`), and GHE/custom-port
  (`ssh://git@host:port/owner/repo`). Without an explicit `normalizeSlug(url)`
  step, derived slugs will mismatch manifest keys for some repos.
  Mitigation: implement a normalizer that strips protocol, auth prefix,
  optional port, and `.git` suffix before slug comparison.
- **Concurrency contention** on git's index lock is *not* a risk — each repo
  has its own `.git/index`. `gh` API rate limits are real; the GraphQL batch
  step keeps requests well below limits.
- **Provider rate-limit pressure**: even with §4 serialization, a 200-repo
  workspace where every repo is dirty makes 200 sequential provider calls.
  At ~3s/call that's 10 minutes of provider wall-clock. Mitigation: this is
  the inherent shape of the workload (one commit message per repo); users
  can `CHI_PROVIDER_PARALLEL=4` if their tier supports it, or use a faster
  provider (Haiku, local Ollama). Not a chi-fixable bug.
