# Architecture Decision Records

One file per decision: `ADR-NNN-<short-title>.md`. Use [the framework template](https://github.com/chevp/chevp-ai-framework/blob/main/templates/adr-template.md).

## Index

| ID | Title | Status |
|----|-------|--------|
| [ADR-001](ADR-001-language-and-runtime.md) | Language and runtime — TypeScript on Node 20+ | Accepted |
| [ADR-002](ADR-002-hand-rolled-command-dispatch.md) | Hand-rolled command dispatch (no commander/yargs) | Accepted |
| [ADR-003](ADR-003-zero-runtime-dependencies.md) | Zero runtime dependencies | Accepted |
| [ADR-005](ADR-005-bundled-workflow-fallback.md) | Bundled workflow fallback | Accepted |
| [ADR-006](ADR-006-worktree-parallelization.md) | Worktrees as the parallelism primitive | Accepted |
| [ADR-008](ADR-008-xstate-narrow-exception.md) | Narrow exception to ADR-003 for state-machine library (XState) in the orchestrator | Proposed |
| [ADR-009](ADR-009-unified-binary-aliases.md) | chi is the single binary — `che` and `jan` are bin aliases | Accepted |

When you add a new ADR, also append a row to the index above once approved.
