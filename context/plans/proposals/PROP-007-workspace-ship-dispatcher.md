---
id: PROP-007
type: PROP
status: open
proposed-by: ai
proposed-at: 2026-05-02
follows-on-from: PRD-002 (finished)
depends-on: ADR-004
---

# PROP-007 — Wire `chi ship` workspace dispatcher (PRD-002 user-path)

## What

Complete the user-facing dispatcher and orchestration that PRD-002 specified
but PR #6 did not ship:

- `src/commands/ship-workspace.ts` — Phase 1 (discovery + auto-clone),
  Phase 2 (parallel triage), Phase 3 (batched gh probe), Phase 4
  (parallel commit-prep, serial-with-progress push).
- `src/commands/ship.ts` — replace the `if (!isInsideRepo()) return 1`
  guard at [src/commands/ship.ts:23](../../../src/commands/ship.ts#L23)
  with delegation to `ship-workspace.run(argv)`.
- `src/commands/doctor.ts` — `chi doctor workspace` target (discovered
  count, unmapped GH repos, stale manifest entries, repos with no
  upstream).
- `src/commands/ship.ts` HELP — workspace-mode section.

## Why

PR #6 landed the primitives (`src/concurrency.ts`,
`src/workspace/discover.ts`, `src/workspace/manifest.ts`,
`src/gh/graphql.ts`, provider semaphore in `src/provider/index.ts`) and
moved PRD-002 to `finished/` with `status: done` and a G3 pass. But
running `chi ship` from `/Users/chevp/workspace/` (the AC #3 path) still
exits with "not a git repository" — the dispatcher was never updated.

Acceptance criteria from PRD-002 that **fail** today:

- AC #3 (workspace mode banner + Phases 1–4)
- AC #4 (`--dry-run`)
- AC #5 (`--no-clone`)
- AC #6 (manifest parse-error diagnostics on stderr, exit 2)
- AC #7 (dirty+ahead triage reflected, only that repo shipped)
- AC #8 (≤ ⌈N/50⌉ `gh api graphql` calls, instrumented assertion)
- AC #9 + #10 (wall-clock targets — testable but not running)
- AC #11 (`chi doctor workspace`)
- AC #12 (per-repo failure does not abort the run)

The primitives have been validated end-to-end (H1+H2 PASS, see
`context/plans/insights-PRD-002.md`); the missing work is mechanical glue
that wires them into the dispatcher.

## Notes

- This is **not** a re-design — ADR-004 stands and PRD-002's design holds.
  The proposal exists only because the gate-pass was signed without the
  user-facing path being shippable, and we need a tracked follow-up
  rather than silent re-opening of PRD-002.
- The split between commit-prep parallelism (`CHI_PROVIDER_PARALLEL`) and
  triage parallelism (`CHI_WORKSPACE_PARALLEL`) per ADR-004 §4 still
  applies. Each subprocess `chi commit --yes` has its own provider
  semaphore (uncontended within the subprocess); cross-process
  serialization comes from the workspace pool size for the commit-prep
  sub-phase.
- Acceptance criteria carry over from PRD-002 verbatim. No new design
  decisions; if any surface during implementation, raise a separate ADR
  rather than expanding scope here.
- Recommendation at `/promote` time: skip the full CTX/EXP/PRD ladder.
  G2 evidence already exists (insights-PRD-002.md). Promote directly to a
  thin PRD-003 that points back to PRD-002 + ADR-004 for design and
  carries only the missing AC.
