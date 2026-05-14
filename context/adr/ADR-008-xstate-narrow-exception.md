---
id: ADR-008
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-11
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-11
supersedes: —
narrows: ADR-003
related: ADR-007-claude-agent-sdk-exception.md, CTX-002-ai-orchestration-providers.md
---

# ADR-008: Narrow Exception to ADR-003 for State-Machine Library (XState) in the Orchestrator

## Status
Accepted (2026-05-11). The actual `dependencies` entry for `xstate` is
added during PRD-003 implementation alongside the Agent SDK dep —
accepting this ADR authorises that change but does not perform it.
EXP-002 may install xstate transiently (`npm install --no-save`) for
its low-fidelity prototype run.

## Context

[CTX-002](../plans/CTX-002-ai-orchestration-providers.md) introduces an
`Orchestrator` layer that wraps the Claude Agent SDK's async iterator
into chi's own command lifecycle. The first draft of CTX-002 modelled
that as an imperative `for await (const event of query(...))` loop
inside `src/commands/consult.ts` — i.e. ad-hoc control flow threading
through `assistant_text`, `tool_use`, `result`, plus chi's custom
`chi.ask_user` round-trip.

User input on 2026-05-11: *"ich möchte auf eine stabile state-machine
in nodejs library setzen und nicht einfach hardcore code."* Two
candidates surveyed via AskUserQuestion:

| Candidate | Verdict |
|-----------|---------|
| **XState v5** | Selected. Battle-tested in production, declarative statecharts (hierarchical states, parallel regions, guards, actions), excellent TypeScript inference via `setup()`, ecosystem (visualizer, devtools, formal verification via Stately Studio). |
| robot3 | Rejected. Smaller (1 KB gzipped), but FSM-only — no statecharts, no actors. Insufficient for the "executingTool" parent state with multiple substates (built-in tool, custom tool with readline pause). |
| in-tree typed FSM (~100 LoC) | Rejected. Cheaper on the supply-chain axis but the user explicitly asked for a "stable" library — meaning maintained by someone other than us. Hand-rolling re-litigates exhaustiveness, replay, devtools, and actor cleanup. |

[ADR-007](ADR-007-claude-agent-sdk-exception.md) already opened a
narrow `dependencies` slot for the orchestration SDK. ADR-008 opens a
**second, equally narrow** slot for the state-machine library.

## Decision

`xstate` (v5+) is added to [package.json](../../package.json)
`dependencies` as a **second narrow exception** to
[ADR-003](ADR-003-zero-runtime-dependencies.md). Specifically:

1. The dep is imported **only** from `src/orchestrator/state-machine.ts`
   and modules transitively reached from there. Command files (`src/commands/*`)
   never import xstate directly.
2. The dep is **lazy-loaded** alongside the Agent SDK: the import lives
   below the orchestrator's public boundary, so commands that do not
   touch orchestration (`status`, `commit`, `ship`, `flow`, `done`,
   `issue`, `explain`, `init` without `--provider=claude`, `update`,
   `config`, `doctor` without the `claude` subcheck, `workflow`, `run`,
   `work`, `release`) pay zero cold-start cost.
3. The state machine is **scoped to the orchestrator** for v1 (per
   user choice 2026-05-11). Existing commands stay imperative. Lifting
   xstate into `src/flow.ts` / `src/ship.ts` etc. would require its own
   ADR justifying scope expansion.
4. Use the **`setup()`-based v5 API** for type-safe machine definition.
   No `assign` action escape hatches that bypass the typed context.
5. **No xstate-react, no xstate-svelte, no @statelyai/inspect** in
   production builds. The visualizer is a dev-time tool only; if used,
   it goes in `devDependencies`, not `dependencies`.

### What this ADR does NOT permit

- Adding any other FSM library (robot3, machina, javascript-state-machine).
- Using xstate outside the orchestrator subtree without a new ADR.
- Adopting Stately Studio's hosted services — the local CLI runs offline
  except for the Anthropic API.
- Stacking @xstate/* utility packages without explicit ADR amendment.

## Alternatives

### Alternative A: hand-roll the state machine in-tree

- **Pros:** Stays at one runtime dep (just the Agent SDK). No supply-
  chain churn from xstate's transitives.
- **Cons:** ~100 LoC of state code we maintain ourselves. No statecharts
  (hierarchical states are tedious to encode by hand). No actor model —
  the SDK iterator wrapping becomes manual setInterval/EventEmitter glue.
  User explicitly rejected this in the 2026-05-11 question.

### Alternative B: robot3

- **Pros:** 1 KB gzipped, simpler audit surface.
- **Cons:** FSM only. The orchestrator needs at least two levels of
  nesting (`running.executingTool.awaitingUser`), which robot3 cannot
  express cleanly. Rejected on capability grounds.

### Alternative C: defer the state machine, keep the imperative loop

- **Pros:** No new dep at all. CTX-002 ships against the iterator-only
  design.
- **Cons:** User explicitly asked for a stable state machine. "Hardcore
  code" with implicit state in local variables and `let phase = ...`
  flags is exactly what they want to avoid. Rejected.

### Alternative D: in-house "library" published to npm under @chevp scope

- **Pros:** "Library" by the strictest reading of the user's word, and
  zero third-party deps.
- **Cons:** Publishing, versioning, and maintaining an FSM lib is a
  separate project. Wildly out of CTX-002 scope. Rejected.

## Consequences

### Positive

- Orchestrator state is explicit, exhaustive, and inspectable. Adding a
  new state (e.g. `pausedForPermissionPrompt` when `permissionMode`
  triggers an SDK callback) is a one-place edit with TS-checked
  exhaustiveness in transitions.
- Tests can drive the machine directly without touching the SDK —
  `inspect()` and `getNextSnapshot()` enable deterministic state
  assertions.
- The shape of `OrchestratorEvent` from CTX-002 collapses into xstate's
  event union, removing one layer of glue code.
- Future "session resume" or "retry on transient SDK error" features
  become state-machine extensions instead of imperative restructures.

### Negative

- Two runtime deps now exist (`@anthropic-ai/claude-agent-sdk` and
  `xstate`). ADR-003's "essentially instant `npm install`" claim is
  further eroded — measure before shipping; if the combined install
  exceeds 50 MB or 15 s on a fresh box, escalate.
- One more API surface to learn for chi contributors. Mitigation:
  state-machine.ts is small (a single machine), and CTX-002's spec is
  the canonical reference for new contributors.
- xstate v5 is younger than v4. Breaking changes between v5 minors are
  plausible. Mitigation: caret range, CI smoke test (machine compiles
  + `createActor(machine).start()` reaches `idle`).

### Risks

- **Library churn (high).** xstate v5 changed substantially from v4
  (no more `Machine()` factory, new `setup()` API). Another major could
  force a rewrite. Mitigation: if a v6 with breaking changes ships
  within 12 months, evaluate switching to in-tree per Alternative A
  before adopting v6.
- **Combined supply-chain (medium).** xstate is currently dependency-
  free at runtime, but that can change. Audit on each upgrade.
- **Over-modelling temptation (medium).** Statecharts invite designing
  more states than needed. Mitigation: CTX-002's state diagram is
  authoritative; states added without a CTX/EXP amendment are rejected
  in review.

## Kill Criteria

Roll back this ADR (and migrate to Alternative A) if any of:

- xstate v5 ships a breaking change that affects the orchestrator
  machine more than once per quarter for two consecutive quarters.
- The combined `node_modules` footprint (Agent SDK + xstate + transitives)
  exceeds 60 MB on a fresh install. The "small CLI" identity is broken.
- An audited security incident in xstate's dependency chain remains
  unpatched > 14 days.
- The state machine's compile-time complexity becomes a barrier to
  contributing (subjective; trip-wire is two consecutive contributors
  reporting "I couldn't add a state without help").
