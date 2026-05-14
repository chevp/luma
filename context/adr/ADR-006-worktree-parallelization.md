---
id: ADR-006
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-02
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-02
supersedes: —
---

# ADR-006: Worktrees as the Parallelism Primitive

## Status
Accepted.

## Context

Single-working-tree workflows force serial development: while a PR is in
review, the user cannot start a new branch without stashing or switching.
The user explicitly asked for "extreme speed" via parallelization
([CTX-001](../plans/CTX-001-worktree-parallelization.md)).

git already provides the necessary isolation primitive — `git worktree` —
which gives each working tree its own `HEAD`, `index`, and per-worktree
`GIT_DIR` (`<common>/.git/worktrees/<name>/`) while sharing the object
store. `chi`'s existing flow marker
([src/commands/flow.ts](../../src/commands/flow.ts) writes to `gitDir()`
which already resolves per-worktree), so the chi-level state is naturally
isolated without further plumbing.

## Decision

Add a thin wrapper command `chi work` over `git worktree`. Specifically:

1. **`chi work <name> [--base <branch>]`** — `git worktree add -b chi/<name> <path> <base>`,
   path defaults to `<repo-parent>/<repo-basename>-<name>`.
2. **`chi work list`** — enumerate worktrees from `git worktree list --porcelain`,
   filter to those with a chi marker.
3. **`chi work rm [<name>]`** — `git worktree remove <path>` (refuses if dirty
   without `--force`).
4. **`chi work cd [<name>]`** — print the worktree path on stdout for shell
   composition (`cd $(chi work cd foo)`).

A per-worktree marker file
`<common-git-dir>/worktrees/<basename(path)>/chi-worktree` identifies
chi-managed worktrees. Content (key=value):

```
name=<user-supplied>
branch=<chi/foo>
base=<main>
source=<absolute path of source repo>
created_at=<ISO 8601>
```

`chi done` gains a **worktree-aware cleanup branch**: when its caller is
inside a chi-managed worktree (detected by `git rev-parse --git-dir !=
--git-common-dir` plus marker presence), after the merge succeeds it
removes the worktree from the source repo (`git worktree remove
--force`) and skips the `git checkout <base>` step that would otherwise
fail (base is checked out in the main worktree). All other commands
(`flow`, `ship`, `issue fix`) are unchanged.

### Naming defaults (env-overridable)

| Setting | Default | Env override |
|---------|---------|--------------|
| Worktree parent dir | `dirname(repoRoot)` | `CHI_WORKTREE_ROOT` |
| Branch prefix | `chi/` | `CHI_WORKTREE_BRANCH_PREFIX` |
| Worktree dir name | `<repoBasename>-<name>` | (path layout fixed) |

### node_modules strategy

v1: do nothing — `git worktree add` produces an empty `node_modules` in
the new worktree; the user runs `npm install` themselves. For `chi`
itself this is irrelevant (zero runtime deps). Symlinking shared
`node_modules` is rejected: native modules fail when reused across paths,
and the breakage is hard to debug.

## Alternatives

### Alternative A: stacked branches without worktrees
- **Pros:** no new file-system layout, no cleanup story.
- **Cons:** still serial — only one branch checked out at a time, the
  whole point was to escape that. Doesn't solve the user's problem.
  Reject.

### Alternative B: full git-worktree wrapper as a top-level command (`chi flow --worktree`)
- **Pros:** unified flow surface.
- **Cons:** changes the semantics of an existing command for a feature
  most users won't reach for. v1's hard scope rule
  ([CTX-001](../plans/CTX-001-worktree-parallelization.md) Risk 4)
  rejects this. Reopen if `chi work` proves popular.

### Alternative C: symlink shared `node_modules` into each worktree
- **Pros:** instant `chi work` with no install delay.
- **Cons:** native modules (e.g. esbuild, sharp, anything compiled per
  platform) cache build artifacts under `node_modules/.bin/` and break
  when reused across paths. Debugging this is brutal because failures are
  silent and post-install. Reject.

### Alternative D: Auto-launch IDE / Claude session inside the worktree (`chi work --open`)
- **Pros:** matches the user's stated goal ("extreme speed") more
  literally — no tab-switching.
- **Cons:** opinionated about editor / agent / shell. v1 prints the path
  so the user can compose it. Defer to a future flag once the surface is
  stable.

## Consequences

### Positive

- Parallel work without stash / switch ceremony. Each worktree has its
  own working tree, index, and chi-flow marker.
- Existing `chi ship` works inside a worktree with no changes — the marker
  is per-worktree, the push goes to a per-worktree branch.
- `chi done` cleans up after itself: the worktree directory disappears
  with the merged branch, no orphans accumulate.

### Negative

- Disk usage: each worktree gets a fresh `node_modules` on first build
  (irrelevant for chi's own repo, relevant for downstream consumers).
- Mental load: users now have multiple working directories per repo,
  and must remember which is which. `chi work list` is the navigation
  affordance.

### Risks

- **Cross-worktree state collision (R1).** Anything writing to the
  *common* `.git/` dir becomes a shared mutex. Today only
  `gitDir()` paths are written by chi (chi-flow marker, chi-last-error.log)
  and both resolve per-worktree. Mitigation: smoke test (G3 acceptance) —
  run `chi ship` from two worktrees in parallel; both must succeed.
- **Stale worktrees.** If `chi done` fails mid-cleanup, the worktree dir
  survives but the branch is gone. Recovery: `git worktree prune`
  (idempotent), then `chi work rm <name> --force`.
- **`bundleRoot()`-style path fragility.** Marker path derivation assumes
  `git rev-parse --git-common-dir` returns a canonical absolute path on
  Windows. Tested manually on macOS only at this stage. Mitigation: if
  Windows breaks, fall back to walking `git worktree list --porcelain`
  and matching basenames.

## Kill Criteria

Roll back this ADR (and remove `chi work` + the done hook) if any of:

- The H2 smoke test fails on first run and the fix is not a one-line
  marker-path adjustment.
- Two or more users report `chi done` corrupting the source repo state
  during worktree cleanup.
- A simpler alternative emerges (e.g. git ships built-in `git worktree
  done`) that subsumes this command.
