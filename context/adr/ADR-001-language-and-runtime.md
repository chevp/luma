---
id: ADR-001
type: ADR
status: accepted
proposed-by: human
decided-by: chevp
approved-by: chevp
approved-at: 2026-04-29
supersedes: —
---

# ADR-001: Language and Runtime — TypeScript on Node 20+

## Status
Accepted.

## Context

`chi` is a port of `che-cli`, an existing Bash project. The goal is a portable CLI with the same UX that runs on Windows, macOS, and Linux without depending on a POSIX shell. We need a language that:

- Has a single, easy-to-install runtime on all three platforms.
- Has a strong type system to catch CLI dispatch / provider-routing bugs at build time.
- Allows zero or near-zero runtime dependencies (see ADR-003).
- Lets us reuse the existing developer's mental model (the rest of the workspace is largely TS / JS / Python).

## Decision

Implement `chi` in **TypeScript**, targeting **Node.js 20 LTS or newer**, compiled to ES modules (`dist/`).

- TypeScript `strict: true`.
- Native `fetch`, ESM, and `node:test` are assumed available, removing the need for polyfills or test-runner deps.
- The compiled artifact under `dist/` is what `bin/chi` and `bin/chi.cmd` execute.

## Alternatives

### Alternative A: Keep Bash (status quo `che-cli`)
- Pros: no compile step; aligned with original implementation.
- Cons: poor Windows story (Git Bash / WSL only); no static typing; harder to grow tests around provider routing.

### Alternative B: Go
- Pros: single static binary; great cross-platform story.
- Cons: heavier toolchain for a small CLI; the rest of this workspace is TS/JS-heavy, so Go would be an outlier.

### Alternative C: Python
- Pros: ubiquitous; readable.
- Cons: runtime version fragmentation on developer machines; weaker types unless we adopt extensive `typing` discipline.

## Consequences

### Positive
- Same toolchain as the rest of the workspace (npm, tsc).
- Strict TS catches dispatch / provider-interface mistakes early.
- Cross-platform out of the box once Node 20+ is installed.

### Negative
- A build step (`tsc`) is required between edit and run; mitigated by `npm run dev`.
- Users must have Node 20+ installed (documented in [README.md](../../README.md)).

### Risks
- Drift between Node LTS releases. Mitigation: pin minimum version in [package.json](../../package.json) `engines`.
