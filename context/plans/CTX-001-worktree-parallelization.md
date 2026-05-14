---
id: CTX-001
type: CTX
status: approved
gate: G1
proposed-by: chevp
proposed-at: 2026-05-02
approved-by: chevp
approved-at: 2026-05-02
supersedes: —
note: G2 (Exploration) skipped by user direction; H2 smoke test moved to G3 acceptance.
---

# CTX-001 — Worktree-based parallelization for `chi`

## Problem statement

A single working tree forces serial work: while a PR is in review, the user
cannot meaningfully start a new branch without stashing or switching. The
goal is to make `chi` open and manage **parallel git worktrees** so that
multiple features / issues / explorations can progress side-by-side without
disturbing each other.

## Hypotheses

**H1 — A thin `chi work` command on top of `git worktree` is sufficient.**
Most of the desired speed-up comes from "another folder, another branch,
another shell" — not from new git plumbing. `git worktree` already provides
the isolation; `chi` only needs ergonomic wrappers and integration with the
existing flow / done / issue commands.
- *Kill criterion:* if a 50-line wrapper around `git worktree add` and
  `git worktree remove` is not enough to deliver the user-visible speed-up
  (i.e. the user still has to remember more than two commands per parallel
  task), H1 is dead and we move to H2.

**H2 — Per-worktree state requires changes to the existing flow marker.**
The current `chi flow` writes `.git/chi-flow`. `git worktree` resolves
`GIT_DIR` per-worktree (`.git/worktrees/<name>/`), so the marker should
already be naturally per-worktree. But if any code path reads the *common*
git dir, parallel `chi ship` / `chi done` calls in different worktrees will
collide.
- *Kill criterion:* a smoke test that runs `chi ship` simultaneously from
  two worktrees of the same repo must succeed in both. If it doesn't, the
  marker / push-recovery code needs auditing first — and the worktree
  feature can't ship until that audit lands.

## Risks

1. **Cross-worktree state collisions.** Anything writing under the *common*
   `.git/` dir (not the worktree-local one) becomes a shared mutex. Push
   recovery, lock files, and any future caching hit this. Mitigation:
   route every `chi`-owned state file through `gitDir()` and add a smoke
   test that proves it resolves to the per-worktree path.

2. **`node_modules` divergence.** Each worktree gets its own `node_modules`
   on first build. For `chi` itself (zero runtime deps) this is free; for
   downstream repos using `chi`, naive workflows will install N times.
   Mitigation: do nothing in v1 (let user decide); add a `--skip-install`
   hint in docs. Symlinking is rejected — breaks native modules.

3. **Orphaned worktrees after merge.** If `chi done` only deletes the branch
   but leaves the worktree directory, the user accumulates dead folders that
   `git worktree list` still references. Mitigation: `chi done` detects
   "we are inside a chi-managed worktree" and removes it after the merge
   succeeds.

4. **Feature-flag-style scope creep.** Worktrees touch every flow that
   assumes a single working directory (`flow`, `done`, `issue fix`, `ship`,
   `status`). Easy to grow this from a wrapper into a full re-architecture.
   Mitigation: v1 ships **only** the new `chi work` namespace + a single
   `chi done` cleanup hook. No changes to `flow` / `issue fix` defaults.

## Scope

### In scope (v1)
- New command namespace `chi work` with subcommands:
  - `chi work <name> [--base <branch>]` — create worktree
  - `chi work list` — list chi-owned worktrees with status
  - `chi work rm [<name>]` — remove worktree (must be clean)
  - `chi work cd [<name>]` — print path for shell-side `cd $(...)`
- `chi done` cleanup hook: when the active flow ran inside a chi-managed
  worktree, remove the worktree after the PR merges.
- One ADR documenting the integration model.
- Smoke test: two parallel `chi ship` calls from different worktrees.

### Out of scope (v1)
- Auto-launching IDE / Claude session inside the new worktree.
- Symlinked / shared `node_modules`.
- Stacked-branch support (worktree-of-worktree, base = feature branch).
- Auto-converting `chi flow` / `chi issue fix` to use worktrees by default.
- Cross-repo orchestration (workspace-level parallelization — different
  problem, different plan).

## System spec — proposed shape

**Naming convention.** chi-owned worktrees live at `<repo-parent>/<repo>-<name>`
(e.g. for repo at `~/workspace/tools/chi`, worktree `pr5` → `~/workspace/tools/chi-pr5`).
Branch name defaults to `chi/<name>`. Both are configurable via env:
- `CHI_WORKTREE_ROOT` — override parent dir
- `CHI_WORKTREE_BRANCH_PREFIX` — override `chi/` prefix

**Identification.** A worktree is "chi-managed" iff a marker file
`.git/worktrees/<name>/chi-worktree` exists (written at create time).
`chi work list` filters on this marker; `chi done` reads it to decide
whether to clean up.

**State model.** Per-worktree marker (`chi-flow`) is unchanged — `git
worktree` already gives each worktree its own `GIT_DIR`, so existing
[src/commands/flow.ts](src/commands/flow.ts) and [src/commands/done.ts](src/commands/done.ts)
should not need internal changes beyond the `--rm-worktree` cleanup hook.

**Concurrency.** No locks introduced. Each worktree operates on its own
HEAD/index. Push to the same remote is serialized by the remote, not by
chi. The H2 smoke test exists to prove this assumption.

## Context inventory — existing code touched

| File | Change |
|------|--------|
| [src/index.ts](src/index.ts) | register `work` command in dispatch table |
| [src/commands/work.ts](src/commands/work.ts) | **new** — implements the namespace |
| [src/commands/done.ts](src/commands/done.ts) | optional worktree cleanup after merge (read marker, call `git worktree remove`) |
| [src/commands/help.ts](src/commands/help.ts) | document `chi work` |
| [README.md](README.md) | porting matrix entry / usage |
| [context/adr/](context/adr/) | new ADR-006 (numbering tbd) |

No changes expected to: `flow.ts`, `ship.ts`, `issue.ts`, provider code.

## ADRs

- **ADR-006 (proposed)** — "Worktrees as the parallelism primitive."
  Records the H1 decision (thin wrapper > custom plumbing), the marker
  scheme, and why we reject symlinked node_modules.

## Open questions — proposed defaults

These were the four questions raised in chat. Recommended defaults
(can be redirected at G1 approval):

| # | Question | Default | Why |
|---|----------|---------|-----|
| 1 | Worktree path layout | `../<repo>-<name>` | IDE sees it, no global state |
| 2 | `node_modules` strategy | run `npm install` if `package.json` exists; document `--skip-install` flag for v1.x | correctness > speed; symlinks break native modules |
| 3 | Auto-launch IDE / claude | **no** — print path; user pipes `cd $(chi work cd x)` | keep v1 minimal; auto-launch is a future flag |
| 4 | `chi flow` / `chi issue fix` default | **unchanged** — worktrees opt-in only via `chi work` | zero risk to existing flows |

## Acceptance criteria for G1 → G2

- [ ] User has confirmed problem statement (or amended it)
- [ ] User has approved or amended the four defaults above
- [ ] H1 and H2 stand (no killing evidence surfaced during discussion)
- [ ] Risks 1–4 acknowledged; mitigations agreed
- [ ] Scope (in/out) signed off
- [ ] Naming convention signed off (path layout, branch prefix)

Once all checked, this plan moves to **EXP-001** (Exploration-B: prototype
the `chi work` surface against the smoke test, then choose between
"`chi work` namespace" vs. "fold into existing `chi flow`").
