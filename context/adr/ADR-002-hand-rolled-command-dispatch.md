---
id: ADR-002
type: ADR
status: accepted
proposed-by: human
decided-by: chevp
approved-by: chevp
approved-at: 2026-04-29
supersedes: —
---

# ADR-002: Hand-Rolled Command Dispatch (no commander/yargs)

## Status
Accepted.

## Context

`chi` exposes a small set of subcommands (`status`, `commit`, `ship`, `flow`, `done`, `issue`, `explain`, `init`, `workflow`, `reinstall`, `config`, `doctor`, `help`). Most are simple verb-style commands with shallow flag surfaces; the project also commits to **zero runtime dependencies** (see ADR-003). A heavy CLI framework would either pull in dependencies or add complexity disproportionate to the surface area.

## Decision

Use a **hand-rolled dispatcher** in [src/index.ts](../../src/index.ts):

- A single `Record<string, CommandRunner>` maps subcommand strings to async runners.
- `process.argv` is sliced manually: `[, , cmd = "help", ...rest]`.
- Help / `-h` / `--help` map to the same runner.
- Each command parses its own flags; there is no shared flag parser.

## Alternatives

### Alternative A: `commander`
- Pros: declarative subcommand definition; auto-generated help.
- Cons: runtime dependency (violates ADR-003); overhead for a CLI with mostly verb-style commands.

### Alternative B: `yargs`
- Pros: rich parsing, validators.
- Cons: same as commander, plus larger install footprint and more API to learn.

### Alternative C: Adopt Node's experimental `util.parseArgs`
- Pros: stdlib, no dependency.
- Cons: still experimental in older Node 20 releases; per-command flag parsing keeps each command self-contained anyway.

## Consequences

### Positive
- Zero dependencies preserved.
- Dispatcher is ~50 lines and trivially auditable.
- Each command owns its flag parsing, matching the original Bash implementation per-file.

### Negative
- No automatic `--help` for subcommands; each command must implement its own help text.
- No declarative validation; flag mistakes surface as runtime errors.

### Risks
- As the surface grows, ad-hoc flag parsing across commands could drift in style. Mitigation: a shared `parseFlags` helper in `src/cli/flags.ts` may be added later (would not require a dependency, just a pattern).
