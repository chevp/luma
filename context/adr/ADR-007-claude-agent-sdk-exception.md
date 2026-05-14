---
id: ADR-007
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-11
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-11
supersedes: —
narrows: ADR-003
related: CTX-002-ai-orchestration-providers.md
---

# ADR-007: Narrow Exception to Zero-Runtime-Dependencies for AI Orchestration SDKs

## Status
Accepted (2026-05-11). The actual `dependencies` entry is added during
PRD-003 implementation — accepting this ADR authorises that change but
does not perform it. EXP-002 may install the SDK transiently
(`npm install --no-save`) for its low-fidelity prototype run.

## Context

[ADR-003](ADR-003-zero-runtime-dependencies.md) declares that chi ships
with **zero runtime dependencies**. The rationale — install/cold-start
cost and supply-chain risk — still holds for utility libraries (ANSI
colour, arg parsing, HTTP clients, etc.) where Node's stdlib is
sufficient.

[CTX-002](../plans/CTX-002-ai-orchestration-providers.md) introduces a
new class of work that the stdlib cannot cover at a reasonable
implementation cost: orchestrated multi-turn agent conversations with
built-in Read/Edit/Bash/Glob/Grep tools and a permission model. The
[claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
implements all of that as the same runtime that powers Claude Code.

Hand-rolling this (an HTTP tool-use loop against the raw Messages API
plus our own file-I/O / Bash / permission machinery) is feasible but
estimated at 1500–2500 LoC, much of which would replicate well-tested
SDK code line-for-line — and would carry a non-trivial security
footprint for the file/bash tools.

## Decision

Carve a **narrow, named exception** out of ADR-003 for AI-orchestration
SDKs. Specifically:

1. `@anthropic-ai/claude-agent-sdk` is added to
   [package.json](../../package.json) `dependencies`.
2. Its transitive deps (notably `@anthropic-ai/sdk` and `zod`) are
   accepted *as a consequence of (1)* — they are not separately approved
   for direct use elsewhere in chi.
3. **No other runtime dependency is approved by this ADR.** Any further
   addition to `dependencies` — even something trivially small — still
   requires its own ADR per ADR-003.
4. The dependency is **lazy-loaded**: the import lives inside
   `src/orchestrator/claude-agent.ts` and is reached only by `chi
   consult` / `chi plan` (and future orchestrator-using commands).
   Cold-start cost for `chi status` / `chi commit` is unchanged because
   their code paths never touch the SDK.
5. **Security defaults**: `Orchestrator.run()` defaults to
   `permissionMode: "plan"` (read-only). Anything that mutates the
   working tree (`acceptEdits`) requires an explicit `--write` flag from
   the user. Anything that runs subprocesses (`bypassPermissions` with
   Bash enabled) requires `--dangerously-allow-bash`, gated behind
   `--write`, with a stderr warning analogous to Claude Code's
   `--dangerously-skip-permissions` muscle memory.
6. The SDK is **isolated behind a chi-owned interface** (`Orchestrator`
   in [src/orchestrator/types.ts](../../src/orchestrator/types.ts)). No
   command imports the SDK directly. This preserves the option to swap
   to the low-level `@anthropic-ai/sdk` or to a different vendor without
   touching command code.

### What this ADR does NOT permit

- Adding `commander`, `yargs`, `chalk`, `kleur`, `ora`, `prompts`,
  `inquirer`, or any other utility library — ADR-003 still bans these.
- Direct use of `zod` (a transitive of the SDK) in chi's own code.
- Adding a second AI SDK (`openai`, `@google/generative-ai`, etc.)
  without a new ADR justifying provider parity.
- Auto-installing the dep in the `chi update` global path — the SDK is a
  declared dependency, npm handles install on `npm install -g
  github:chevp/chi` as usual.

## Alternatives

### Alternative A: Hand-roll the tool loop against `@anthropic-ai/sdk`

- **Pros:** Smaller dep footprint (one SDK instead of one SDK + its
  built-in-tools layer); maximum control over every tool invocation;
  trivially auditable in-tree.
- **Cons:** Owning the safe implementation of Read/Edit/Write/Bash tools
  with path-traversal protection, permission prompts, and timeout
  handling. Estimated 1500–2500 LoC; Claude Code spent months hardening
  exactly this surface and chi would re-litigate every CVE-class bug.
  Rejected for v1; kept available as fallback if the Agent SDK proves
  unfit (CTX-002 kill criterion).

### Alternative B: Vendor the Agent SDK source into `vendor/`

- **Pros:** Strictly speaking, zero `dependencies` entries.
- **Cons:** Defeats the purpose of ADR-003 — the supply-chain surface is
  the *code*, not the `package.json` line. Vendoring just hides the
  same surface in a less audited place, and we lose automatic security
  updates. Rejected.

### Alternative C: Make the Agent SDK an `optionalDependencies` entry

- **Pros:** Users who never touch `chi consult` install nothing.
- **Cons:** `optionalDependencies` are still installed by default; the
  only behaviour change is that npm doesn't fail when install fails.
  That's actively bad here — silent failures lead to "why doesn't `chi
  consult` work" support burden. Lazy-loading the import (decision
  point 4) achieves the cold-start goal without the install ambiguity.
  Rejected.

### Alternative D: Shell out to the `claude` Claude Code CLI

- **Pros:** Zero npm deps; reuses an existing trusted binary.
- **Cons:** Requires every chi user to have Claude Code installed on
  PATH (currently not assumed). Communication channel is line-oriented
  stdout, which makes structured tool-use and ask-user-question loops
  far harder than the SDK's native types. Reopen this if the SDK
  becomes unviable.

## Consequences

### Positive

- chi gains a first-class agent runtime without owning ~2 kLoC of
  security-sensitive code.
- Existing commands (`status`, `commit`, `ship`, `flow`, `done`,
  `issue`, `explain`, `init`, `update`, `config`, `doctor`, `workflow`,
  `run`) keep ADR-003's properties: zero load-time cost from the new
  dep, no new transitive surface unless they reach into the
  orchestrator.
- The `Provider` interface stays untouched — `cura` and `ollama`
  continue to serve their existing commands. Provider-parity rule
  (CLAUDE.md) is satisfied by documenting *why* claude-agent does not
  live in the `Provider` abstraction (multi-turn tool use is
  qualitatively different from one-shot `generate`).

### Negative

- The "zero runtime dependencies" banner in the README needs an
  asterisk. Mitigation: README states "one AI orchestration SDK, lazy-
  loaded — see ADR-007."
- `npm install` of chi globally now pulls the SDK chain. On a fresh box
  this is on the order of 5–15 MB and a few seconds — measured before
  shipping; if it exceeds 30 MB or 10 s, revisit.
- Future "just add one small dep" requests will cite this ADR. Decision
  4 (lazy-load) and decision 6 (interface isolation) plus the explicit
  "What this ADR does NOT permit" list are the bulwark; the review loop
  must hold the line.

### Risks

- **SDK version churn.** The Agent SDK is young; breaking changes
  between minors are plausible. Mitigation: pin to a caret range that
  excludes majors (`^x.y.z`) and add a CI smoke test that imports
  `query` and asserts the shape of the returned async iterator. If the
  SDK breaks chi twice in a quarter, fall back to Alternative A.
- **Confused-deputy via prompt injection.** A document chi reads might
  contain `<system>` instructions like "delete this file." The
  `permissionMode: "plan"` default mitigates this for the read-only
  case; for `--write` runs the user has consented to file mutations and
  the SDK's permission prompts (when not in `bypassPermissions`) provide
  the second line of defence.
- **Credential leakage.** `ANTHROPIC_API_KEY` is now a credential chi
  reads. `~/.chi/config` is already chmod 600; the new key follows the
  same path. The SDK reads the env var at `query()` time, so chi never
  writes the key to disk other than via the existing config-write code.

## Kill Criteria

Roll back this ADR (and the SDK dependency) if any of:

- The SDK adds a feature that requires chi to expose its API key to a
  third-party endpoint by default (e.g. mandatory telemetry beacons we
  can't disable).
- A high-severity supply-chain incident is reported in the SDK's
  dependency tree and remains unpatched for > 14 days.
- The 50-line prototype required by CTX-002's H2 kill criterion fails
  to complete an end-to-end run (then CTX-002 dies first, and this ADR
  has no consumers).
