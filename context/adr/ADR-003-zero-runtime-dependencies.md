---
id: ADR-003
type: ADR
status: accepted
proposed-by: human
decided-by: chevp
approved-by: chevp
approved-at: 2026-04-29
supersedes: —
---

# ADR-003: Zero Runtime Dependencies

## Status
Accepted.

## Context

`chi` is a small developer CLI invoked frequently from interactive shells. Two concerns dominate:

1. **Install / cold-start cost.** Every npm dependency adds install time, disk footprint, and audit surface. For a CLI that runs in milliseconds, a multi-MB `node_modules` is disproportionate.
2. **Supply-chain risk.** A CLI that calls AI providers and runs git commands sits close to credentials and the working tree. Each transitive dep is a potential exposure.

Node 20+ already ships with `fetch`, ESM, `node:test`, and a strong stdlib, removing the historical reasons to depend on `axios`, `chalk`, `commander`, etc.

## Decision

`chi` ships with **zero runtime dependencies**. The `dependencies` field in [package.json](../../package.json) stays empty.

- `devDependencies` may include the TypeScript compiler and `@types/node`.
- Provider integrations call external CLIs (`claude-code`, `gh copilot`) via `child_process`, or HTTP via native `fetch` — never via a vendor SDK.
- ANSI coloring, arg parsing, and git porcelain interpretation are implemented in-tree (see [src/ui.ts](../../src/ui.ts), [src/index.ts](../../src/index.ts), [src/git/index.ts](../../src/git/index.ts)).

Adding any runtime dependency requires a new ADR that supersedes this one (or an explicit `Accepted` ADR carving out a narrow exception).

## Alternatives

### Alternative A: Pull in `chalk` + `commander` (industry default)
- Pros: less code to write; standard look-and-feel.
- Cons: install footprint, supply-chain surface, and version churn for negligible feature gain.

### Alternative B: Bundle deps with esbuild into a single file
- Pros: still zero install-time deps for users.
- Cons: opaque bundle in `dist/`, harder to audit, harder to debug stack traces.

## Consequences

### Positive
- `npm install` is essentially instant.
- Audit surface is the codebase itself.
- Forces small, focused implementations (e.g. ANSI helpers in `src/ui.ts`).

### Negative
- We re-implement small utilities (color, kv-printing, flag parsing) that a dep would otherwise provide.
- Some features (e.g. interactive TUI) become harder to add without lifting this constraint via a new ADR.

### Risks
- Pressure to "just add one small dep" will recur. Mitigation: this ADR exists explicitly so the conversation moves into the ADR review loop instead of into a one-off PR.
