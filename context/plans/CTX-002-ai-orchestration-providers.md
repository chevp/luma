---
id: CTX-002
type: CTX
status: approved
gate: G1
proposed-by: ai
proposed-at: 2026-05-11
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-11
amended-at: 2026-05-11
supersedes: —
related: PROP-007-chevix-agents-consult.md
adrs: ADR-007-claude-agent-sdk-exception.md, ADR-008-xstate-narrow-exception.md
evidence:
  hypothesis: A new orchestration layer above Provider, the high-level claude-agent-sdk, a stable state-machine library (XState) wrapping the SDK iterator, and a "consult + plan + workspace-awareness" command set is the right v1 surface for AI orchestration in chi.
  result: User confirmed all four architectural choices via AskUserQuestion (2026-05-11) — SDK = claude-agent-sdk, scope = full stack + workspace-awareness, seam = orchestrator above provider, state machine = XState scoped to the orchestrator. Defaults #4–#8 accepted with refinement on #8 (key blocks only claude-agent-backed commands).
  reasoning: Choices match user's stated goal ("verschiedene provider für ai-orchestrierung, neue commands, anthropic SDK, ask-user-questions, stable state-machine library — kein hardcore code"). The orchestrator-above-provider seam keeps cura/ollama working unchanged; the SDK choice trades 1500–2500 LoC of security-sensitive hand-rolled code for one well-scoped dep behind ADR-007. The XState choice replaces ad-hoc imperative control flow with a typed, inspectable state machine behind ADR-008. The #8 refinement makes the cost of adoption strictly opt-in.
amendment-log:
  - date: 2026-05-11
    by: chevp
    change: Added Decision #9 (state-machine basis = XState, orchestrator-scoped). System spec section "Orchestrator interface" rewritten to be state-machine based. New hypothesis H4 added. ADR-008 added to authorise the xstate dep. EXP-002 prototype script updated to cover the state-machine wrapper.
  - date: 2026-05-11
    by: chevp
    change: Added Decision #10 (orchestrator code lives inside chi for v1, extracted to its own package only when a second non-chi-wrapper consumer appears). Explicit extraction-trigger criteria added to the Out-of-scope section. No structural changes to ADR-007 or ADR-008 — both remain chi-scoped for v1.
---

# CTX-002 — AI-Orchestration Providers & Framework-aware CLI

## Problem statement

`chi` today knows two providers — `cura` (hosted Ollama) and local `ollama` —
and the [Provider interface](../../src/provider/types.ts) only exposes a
fire-and-forget `generate(prompt: string) => Promise<string>`. That is
enough for short helpers like `chi commit` or `chi explain`, but it cannot
host the orchestrated workflows that the user now wants chi to drive:

- Multi-turn agent conversations with **tool use** (read/write files, run
  bash, search the workspace).
- Interactive **ask-user-question** loops (chi pauses, the model asks,
  the user answers via the terminal, chi resumes).
- The **chevp-ai-framework** governance loop — Context (G1) → Exploration
  (G2) → Production (G3), with `/approve`, `/promote`, `/reject` actions
  on `CTX/EXP/PRD/PROP` artifacts under [context/plans/](.).
- Workspace-awareness: when chi runs from the top-level `~/workspace`
  root rather than inside a single repo, cross-repo questions should be
  answerable.

Five questions this plan must answer before G2 (Exploration):

1. What is the **new Provider surface** for tool-use / multi-turn / streaming —
   and how does it stay non-disruptive to the existing `cura`/`ollama`
   providers that only do `generate`?
2. Which **chi commands** materialize the framework's mensch-KI-Schnittstelle
   (`consult`, `plan`, `gate`, `approve`, `promote`, `reject`) and which
   are deferred to a follow-up plan?
3. How does chi **detect workspace mode** (running at workspace root vs.
   inside a sub-repo) and how does that change provider/agent routing?
4. How is the **first runtime dependency** (`@anthropic-ai/claude-agent-sdk`)
   reconciled with [ADR-003 Zero Runtime Dependencies](../adr/ADR-003-zero-runtime-dependencies.md)?
   This requires a new ADR that carves out a narrow exception.
5. How does the new `claude-agent` provider interact with the framework's
   **gatekeeper subagents** (`gatekeeper-g1/g2/g3`) — does chi spawn them
   directly via the Agent SDK's `Task` tool, or via a chevix-agents lookup?

## Hypotheses

**H1 — A new `Orchestrator` layer above `Provider` is sufficient; the
existing `Provider` interface stays untouched.**
The chevp-ai-framework workflows (multi-turn + tool use + ask_user) are
qualitatively different from one-shot text generation. Mixing them into
the same interface would force every provider (including the local
`ollama` smollm2:135m that has no tool-use support) to implement methods
it will never run.

- *Kill criterion:* if implementing two real commands (`chi consult` and
  `chi plan`) requires us to add more than one new method to the existing
  `Provider` interface, H1 is dead and we move to extending `Provider`
  with optional capabilities. The boundary is: the new orchestrator may
  *call* `Provider.generate()` for small completions (e.g. issue title
  drafting) but no orchestration logic leaks into the `Provider` contract.

**H2 — The `@anthropic-ai/claude-agent-sdk` covers ≥ 90 % of the desired
file-I/O, bash, and ask-user-question surface out of the box; custom
chi-specific tools are an additive layer (MCP server or in-process tool
registration) rather than a replacement.**
The user picked the high-level Agent SDK precisely so chi does not
re-implement Read/Edit/Bash. Custom tools chi will need:
- `chi.plan.create` / `chi.plan.list` (creates CTX/EXP/PRD files with
  frontmatter)
- `chi.gate.run` (invokes a gatekeeper subagent on a given plan-id)
- `chi.ask_user` (forwards a question to the terminal via readline)

- *Kill criterion:* if the Agent SDK's built-in tools cannot be combined
  with a custom in-process tool list (i.e. enabling `Read` forces us to
  also accept some sandbox we cannot escape, or custom tools cannot
  return structured `tool_result` blocks the model treats as first-class),
  H2 is dead and we fall back to the low-level `@anthropic-ai/sdk` and
  implement the loop ourselves. This re-opens the SDK choice decision.

**H4 — A single XState v5 machine cleanly wraps the Agent SDK's async
iterator without re-implementing the SDK's tool loop.**
The SDK already runs its own internal tool loop (it calls our registered
`chi.ask_user` tool function, waits for the result, then continues).
Our state machine therefore does **not** replace the loop — it observes
the SDK's emitted events (`assistant`, `tool_use`, `result`) via a
single `fromCallback` actor, transitions accordingly, and exposes a
stable, typed `Snapshot` for CLI rendering, audit, and tests. Imperative
control flow (`for await { if (...) }`) is fully replaced.

- *Kill criterion:* if wrapping the SDK iterator in a single
  `fromCallback` actor (≤ 40 LoC of glue) cannot produce all four
  observable transitions (`idle → running → executingTool →
  awaitingUser → running → done`) in the EXP-002 prototype, H4 dies and
  we either (a) move to a multi-actor architecture inside the same
  machine, or (b) escalate to Alternative A from ADR-008 (in-tree FSM)
  and revisit the state-machine choice.

**H3 — Workspace-mode detection is a 20-line resolver, not a new
subsystem.**
chi can detect workspace mode by walking up from `cwd` until it either
hits a directory containing a `CLAUDE.md` that mentions
"chevp-workflow" / "Workspace Mode" *and* contains sub-folders that are
themselves git repos, or hits filesystem root. The same resolver picks
the cwd that gets handed to the Agent SDK (`options.cwd`).

- *Kill criterion:* if the resolver produces false positives on a
  realistic workspace fixture (≥ 5 sub-repos with their own CLAUDE.md),
  H3 is dead and we require an explicit `chi config workspace_root` env
  var instead of auto-detect.

## Risks

1. **Runtime dependency lock-in (R1, expensive).** Adding
   `@anthropic-ai/claude-agent-sdk` permanently breaks
   [ADR-003](../adr/ADR-003-zero-runtime-dependencies.md). The SDK pulls
   its own transitive deps (the Anthropic JS SDK plus zod, etc.). Once
   accepted, *future* one-off "just one small dep" PRs will cite this as
   precedent. Mitigation: ADR-007 must explicitly narrow the exception
   to "SDKs strictly required for AI orchestration", forbid generic
   utility deps, and require any further dep to spawn its own ADR.

2. **API-key handling on machines that have only cura credentials (R2,
   expensive).** Today chi reads `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`
   from env or `~/.chi/config`. The Agent SDK needs `ANTHROPIC_API_KEY`.
   If a user runs `chi consult` without the new key, we must fail with a
   clear "missing ANTHROPIC_API_KEY — run `chi init --provider=claude`"
   rather than a stack trace from inside the SDK. Mitigation: extend
   `chi doctor` to check for the new key when the active provider is
   claude-agent; add `chi init --provider=claude` flow analogous to the
   existing cura-credentials prompt.

3. **Permission-mode footgun (R3, expensive).** The Agent SDK's
   `bypassPermissions` mode lets the model write to and delete files
   silently. If `chi consult` defaults to that, a malicious prompt or
   confused-deputy attack could damage the working tree. Mitigation:
   default to `permissionMode: "plan"` for `chi consult` (read-only),
   require an explicit `--write` flag to unlock `acceptEdits`, and a
   second flag `--dangerously-allow-bash` for `bypassPermissions`. Mirror
   the warning text from the existing
   `--dangerously-skip-permissions` muscle memory.

4. **Provider-parity drift.** CLAUDE.md mandates "when adding behavior to
   one provider, mirror it in the others (or document why not)." The
   `cura` and `ollama` providers cannot meaningfully implement tool-use
   against `smollm2:135m`. Mitigation: keep the new capability *out* of
   the `Provider` interface entirely (per H1). The orchestrator layer is
   claude-only; `cura`/`ollama` continue to work for `commit/explain/etc.`
   unchanged. Document the deliberate split in ADR-007.

5. **Plan/gate command scope creep.** "Voller Stack inkl. Workspace-
   Awareness" easily expands into a full re-implementation of the
   framework's `/approve`, `/promote`, `/reject`, `/defer`, `/gate-
   override` surface plus all three gatekeeper subagents. Mitigation:
   v1 in this plan ships only `chi consult` and `chi plan new
   <CTX|EXP|PRD|PROP|ADR>`. `chi gate` and `chi approve` are deferred
   to a follow-up CTX-003 (see Out of scope below).

## Scope

### In scope (v1, this plan)

- **New provider:** `claude-agent` (uses `@anthropic-ai/claude-agent-sdk`),
  registered alongside `cura`/`ollama` but exposed via the new orchestrator
  layer, not the `Provider` interface.
- **New orchestrator layer** at `src/orchestrator/`:
  - `types.ts` — `Orchestrator`, `OrchestratorOptions`, `AskUserHandler`.
  - `claude-agent.ts` — wraps `query()` from the Agent SDK, surfaces
    assistant messages and `tool_use` events.
  - `ask-user.ts` — readline-based terminal Q&A; pluggable via
    `AskUserHandler` so workflow YAML or tests can stub it.
  - `index.ts` — `getOrchestrator(name?)` picker.
- **New commands** (registered in [src/index.ts](../../src/index.ts)):
  - `chi consult [<question>] [--agent <name>] [--write] [--dangerously-allow-bash]`
  - `chi plan new <CTX|EXP|PRD|PROP|ADR> "<title>"` — scaffolds a new
    file with framework-conformant frontmatter under `context/plans/` or
    `context/adr/`.
  - `chi plan list [<type>]` — enumerates plans by type/status.
- **Workspace-mode detection** in `src/workspace.ts`:
  - `resolveWorkspaceRoot(cwd): { mode: "workspace" | "repo"; root: string }`.
  - Consumed by `chi consult` to pick `options.cwd` for the Agent SDK.
- **Config surface:** new `~/.chi/config` keys + envs:
  - `anthropic_api_key` / `ANTHROPIC_API_KEY`
  - `claude_model` / `CHI_CLAUDE_MODEL` (default `claude-opus-4-7`)
  - `claude_permission_mode` / `CHI_CLAUDE_PERMISSION_MODE`
    (default `plan` — read-only)
- **`chi doctor claude`** — verifies `ANTHROPIC_API_KEY` is set and a
  one-token `query()` call succeeds.
- **`chi init --provider=claude`** — interactive prompt for the API key,
  writes to `~/.chi/config` with chmod 600.
- **One ADR:** ADR-007 carves the narrow `@anthropic-ai/claude-agent-sdk`
  exception out of ADR-003.

### Out of scope (deferred to CTX-003 / future PROPs)

- `chi gate g1|g2|g3` — gatekeeper subagent invocations. Needs
  chevix-agents vendoring decision (still open per PROP-007).
- `chi approve <plan-id>` / `chi reject` / `chi promote` / `chi defer` —
  the `/approve` family. Touches frontmatter rewriting in YAML; deserves
  its own scoped plan.
- Cross-repo `chi consult --workspace` — answering one question against
  multiple sub-repos. Intersects with PROP-006 (workspace-ship); track
  there.
- Streaming output in the terminal (`--stream`). v1 prints assistant
  messages on completion; streaming is a follow-up flag.
- Custom MCP servers for chi-specific tools beyond the three listed in
  H2. The ADR locks the surface; new tools require their own plan entry.
- Replacing or removing the existing `cura`/`ollama` providers. They
  continue to serve `chi commit` / `chi explain` / `chi issue` unchanged.
- **Extracting the orchestrator into a separate package
  (`@chevp/orchestrator`, npm workspaces, or moving it into
  `chevp-ai-framework`).** v1 lives at `src/orchestrator/` inside this
  repo. See extraction triggers below.

### Extraction triggers (when to re-open Decision #10)

Spawn a `PROP-NNN-extract-orchestrator.md` *only* when at least one of
the following is concretely true — not as anticipation, not "we might
need this":

1. **A second, non-wrapper consumer materialises.** `jan-cli` does
   *not* count (it is a chi binary alias, not an independent code
   base). A second consumer means a separate repository with its own
   `package.json` that wants to call the orchestrator without depending
   on chi's git helpers, command dispatcher, or config layer. If
   `che-cli` resurrects and wants the orchestrator, or a new tool in
   `~/workspace/tools/` is created that needs it — that's the trigger.

2. **A clean API boundary stabilises on its own.** If, after PRD-003
   ships and a few cycles of real use, the orchestrator's exported
   surface has had no breaking changes for ≥ 2 months and contains no
   imports from outside `src/orchestrator/`, that is evidence the
   boundary is real and extraction is now low-risk. (Today neither
   condition holds: the orchestrator doesn't exist, and once it does it
   will probably reach into `src/git/`, `src/ui.ts`, and `src/config.ts`
   during development.)

3. **Versioning pressure.** If chi has a slow release cadence (driven
   by git-workflow stability) but the orchestrator needs frequent
   updates (driven by SDK / state-machine churn), independent SemVer
   becomes load-bearing. Trigger: ≥ 3 instances within 6 months where
   "we'd ship the orchestrator change today but chi isn't ready."

4. **Framework integration.** If `chevp-ai-framework` evolves a formal
   conformance specification ("an orchestrator is conformant iff it
   exposes `start/subscribe/send` with this `Snapshot` shape"), it
   makes sense to host the reference implementation alongside the
   framework rather than inside chi. Trigger: framework adds a
   `conformance/` directory or otherwise codifies the contract.

When **none** of these are true, in-tree is the correct location and
re-litigating extraction is wasted effort.

## System spec — proposed shape

**Layering.**

```
src/
  provider/                    ← unchanged (cura, ollama, generate-only)
    types.ts
    cura.ts
    ollama.ts
    index.ts
  orchestrator/                ← NEW
    types.ts                   ← public types: Orchestrator, OrchestratorOptions,
                                  OrchestratorEvent, Snapshot, AskUserHandler
    state-machine.ts           ← XState v5 machine definition (single file,
                                  authoritative). Per ADR-008.
    claude-agent.ts            ← thin facade: wraps state-machine.ts as the
                                  exported Orchestrator instance.
    sdk-actor.ts               ← fromCallback actor: pumps @anthropic-ai/
                                  claude-agent-sdk's async iterator into
                                  machine events.
    ask-user.ts                ← readline Q&A; default AskUserHandler.
    tools/                     ← in-process tool definitions
      chi-plan.ts              ← chi.plan.create / chi.plan.list
      chi-ask-user.ts          ← chi.ask_user (delegates to ask-user.ts)
    index.ts                   ← getOrchestrator() picker
  workspace.ts                 ← NEW: resolveWorkspaceRoot()
  commands/
    consult.ts                 ← NEW: drives orchestrator via Snapshot subscription
    plan.ts                    ← NEW
    ... (existing)
```

**Architectural rule (per ADR-008).** Only files inside
`src/orchestrator/` import `xstate` or `@anthropic-ai/claude-agent-sdk`.
Command files subscribe to the orchestrator's typed `Snapshot` stream and
never see the underlying machine or SDK types.

**State machine (XState v5, single machine).**

```
                               ┌─────────┐
                               │  idle   │
                               └────┬────┘
                          START(prompt, options)
                                    ▼
                           ┌────────────────┐
                           │    running     │     ◄─── parent state
                           │  (initial:     │
                           │   receiving)   │
                           └───┬────────────┘
        ┌──────────────────────┼─────────────────────┐
        ▼                      ▼                     ▼
   receivingText        executingTool          (transient)
        │                    │                       │
        │           ┌────────┴────────┐              │
        │           ▼                 ▼              │
        │     builtInTool        chiAskUser          │
        │   (Read/Glob/Grep      (readline           │
        │    handled by SDK)      pause)             │
        │           │                 │              │
        └───────────┴─────────────────┘──────────────┘
                              │
                  RESULT(stopReason, cost)
                              ▼
                       ┌───────────┐
                       │   done    │   ◄─── final
                       └───────────┘

Cross-cutting transitions (any non-final state):
  ERROR(e)           → terminated.error
  USER_CANCELLED     → terminated.userCancelled
```

States are exhaustive and TypeScript-checked via `setup({ types: ... })`.
Adding a new state (e.g. `pausedForPermissionPrompt` if `acceptEdits`
ever needs an interactive callback) is a one-place edit.

**`Orchestrator` interface (revised — Snapshot-based, not iterator-based).**

```ts
import type { Actor, Snapshot as XStateSnapshot } from "xstate";

export interface OrchestratorOptions {
  cwd: string;                          // resolved via workspace.ts
  permissionMode: "plan" | "acceptEdits" | "bypassPermissions";
  allowedTools: string[];               // Agent SDK built-ins + chi.* tools
  model?: string;                       // default "claude-opus-4-7"
  askUser?: AskUserHandler;             // pluggable; default = readline
  systemPrompt?: string;                // for agent persona injection
}

export interface AskUserHandler {
  prompt(question: string, options?: string[]): Promise<string>;
}

/** Stable, narrow view chi commands subscribe to. Hides xstate. */
export interface Snapshot {
  state:
    | "idle"
    | "running.receivingText"
    | "running.executingTool.builtInTool"
    | "running.executingTool.chiAskUser"
    | "done"
    | "terminated.error"
    | "terminated.userCancelled";
  lastAssistantText?: string;
  pendingToolName?: string;        // when state is running.executingTool.*
  pendingQuestion?: string;        // when state is running.executingTool.chiAskUser
  tokens?: { input: number; output: number };
  error?: { message: string; cause?: unknown };
}

export interface Orchestrator {
  readonly name: "claude-agent";
  ping(): Promise<boolean>;
  /** Start a run. Returns an actor; subscribe for Snapshot updates. */
  start(opts: OrchestratorOptions, prompt: string): {
    subscribe(listener: (snap: Snapshot) => void): { unsubscribe(): void };
    send(event: { type: "USER_CANCELLED" }): void;
    done: Promise<Snapshot>; // resolves on final state
  };
}
```

The `Snapshot` union is what command code (e.g.
[src/commands/consult.ts](../../src/commands/consult.ts)) renders. It is
deliberately narrower than xstate's internal snapshot type so we can
swap state-machine libraries (Alternative A in ADR-008) without
changing command code — same defensive boundary as we already enforce
for the SDK in CTX-002.

**Defaults that lock-in safety.**

| Concern | Default | Override |
|---------|---------|----------|
| Permission mode | `plan` (read-only) | `--write` → `acceptEdits` ; `--dangerously-allow-bash` → `bypassPermissions` |
| Tools allowed | `Read`, `Glob`, `Grep`, `chi.ask_user`, `chi.plan.list` | `--write` adds `Edit`, `Write` ; `--dangerously-allow-bash` adds `Bash` |
| Working dir | Workspace root if detected, else repo root | `--cwd <path>` |
| Model | `claude-opus-4-7` | `--model <id>` or `CHI_CLAUDE_MODEL` |

**`chi consult` lifecycle.**

1. Parse argv. If no `<question>`, prompt via readline.
2. `resolveWorkspaceRoot(process.cwd())` → set `options.cwd`.
3. Pick allowed tools per flags. Refuse `--dangerously-allow-bash`
   without `--write` (explicit safety).
4. `getOrchestrator("claude-agent").run(opts, question)`.
5. For each event:
   - `assistant_text` → print to stdout.
   - `tool_use` → print one-line audit (`→ Read src/foo.ts`).
   - `ask_user` → readline prompt, send back as tool_result.
   - `result` → print cost/tokens to stderr.
6. Exit code 0 on completion, 1 on SDK error, 2 on user-cancelled.

**`chi plan new <type> "<title>"` lifecycle.**

1. Determine next `NNN` for the given type (`CTX/EXP/PRD/PROP/ADR`) by
   scanning the relevant folder.
2. Slugify title → filename.
3. Write file with framework-conformant frontmatter:
   `id`, `type`, `status: proposed`, `proposed-by: ai|human|pair`,
   `proposed-at: <today>`, empty body with the section skeleton from
   [CTX-001](CTX-001-worktree-parallelization.md).
4. Print the new path on stdout.

## Context inventory — existing code touched

| File | Change |
|------|--------|
| [src/index.ts](../../src/index.ts) | register `consult`, `plan` in dispatch table |
| [src/provider/types.ts](../../src/provider/types.ts) | **unchanged** (H1) |
| [src/provider/index.ts](../../src/provider/index.ts) | **unchanged** (orchestrator is parallel, not nested) |
| [src/orchestrator/](../../src/) | **new** subtree (see System spec) |
| [src/workspace.ts](../../src/) | **new** (workspace-root resolver) |
| [src/commands/consult.ts](../../src/commands/) | **new** |
| [src/commands/plan.ts](../../src/commands/) | **new** |
| [src/commands/init.ts](../../src/commands/init.ts) | add `--provider=claude` branch |
| [src/commands/doctor.ts](../../src/commands/doctor.ts) | add `claude` check |
| [src/commands/help.ts](../../src/commands/help.ts) | document `consult` + `plan` |
| [src/config.ts](../../src/config.ts) | three new keys in `KEY_TO_ENV` |
| [package.json](../../package.json) | add `@anthropic-ai/claude-agent-sdk` to `dependencies` |
| [README.md](../../README.md) | porting matrix entry, usage section |

## ADRs

- **[ADR-007](../adr/ADR-007-claude-agent-sdk-exception.md) (accepted)**
  — Narrow exception to ADR-003 for `@anthropic-ai/claude-agent-sdk`.
  Records the carve-out, the security defaults (`permissionMode: "plan"`
  default, opt-in bash), and the rule that any further runtime
  dependency still requires its own ADR.
- **[ADR-008](../adr/ADR-008-xstate-narrow-exception.md) (proposed)**
  — Second narrow exception to ADR-003 for `xstate` v5+, scoped strictly
  to the orchestrator subtree. Added after the 2026-05-11 amendment to
  CTX-002 (user requirement: "stable state-machine in a Node.js library,
  not hardcore code"). Authorises the dep used by `state-machine.ts`.

## Kill Criteria

Roll this plan back to proposal (or to a smaller PROP) if any of:

- ADR-007 cannot get past review: the user prefers to stay 100 % zero-
  dependency. Fallback: implement against the low-level
  `@anthropic-ai/sdk` only and hand-roll Read/Write/Bash tools — this is
  a different plan and re-opens the SDK choice.
- A 50-line prototype of `Orchestrator.run()` with one built-in tool
  (`Read`) and one custom tool (`chi.ask_user`) cannot complete an
  end-to-end "ask, read a file, answer" round-trip on
  `claude-opus-4-7`. H2 dies, see its kill criterion.
- The Agent SDK's permission model leaks: `permissionMode: "plan"`
  performs writes anyway in a test fixture. Without a watertight
  read-only mode, R3 is unfixable and we cannot ship `chi consult` as
  a safe default.

## Open questions — proposed defaults

These were settled via AskUserQuestion (per framework rule) before
authoring this plan:

| # | Question | User choice | Why this plan reflects it |
|---|----------|-------------|---------------------------|
| 1 | Which SDK? | `@anthropic-ai/claude-agent-sdk` (high-level) | One new dep, one ADR; tool-loop owned by SDK |
| 2 | Command scope? | Full stack incl. workspace-awareness | This plan adds `consult` + `plan` + workspace resolver; `gate`/`approve` deferred to CTX-003 to keep v1 shippable |
| 3 | Provider seam? | New orchestrator layer above Provider | `Provider` interface untouched; H1 codifies the boundary |
| 9 | State-machine basis? | `xstate` v5, scoped to the orchestrator subtree | Second narrow exception (ADR-008). User requirement: "stable state-machine, not hardcore code." H4 added to validate the wrapping pattern. |
| 10 | Orchestrator in chi or a separate package? | **In chi for v1; extract when a second non-wrapper consumer appears.** | User raised the question 2026-05-11 ("zerschreddert das chi nicht?"). Premature extraction means designing a public API before the orchestrator exists; the cost of "now extract" is double release ceremony with no second consumer. See Out-of-scope for the extraction triggers. |

Remaining defaults — confirmed by user 2026-05-11 (awaiting formal
`/approve` to flip frontmatter `decided-by`/`approved-by`):

| # | Question | Decided default | Override path |
|---|----------|-----------------|---------------|
| 4 | Default permission mode for `chi consult` | `plan` (read-only) | `--write` / `--dangerously-allow-bash` |
| 5 | Default model | `claude-opus-4-7` | `CHI_CLAUDE_MODEL` env / `--model` flag |
| 6 | Where does workspace-root detection live? | New `src/workspace.ts` | Could move to `src/git/` later if it grows |
| 7 | Custom tool prefix | `chi.*` (e.g. `chi.ask_user`, `chi.plan.create`) | Matches Claude Code's `mcp__<server>__<tool>` shape conceptually |
| 8 | When does `ANTHROPIC_API_KEY` become a hard requirement? | **Only when invoking a claude-agent-backed command** (`chi consult`, `chi plan new`, future `chi gate`/`chi approve`). All pre-existing commands (`status`, `commit`, `ship`, `flow`, `done`, `issue`, `explain`, `init` without `--provider=claude`, `update`, `config`, `doctor` without the `claude` subcheck, `workflow`, `run`, `work`, `release`) must continue to function with **only** `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` set, exactly as today. Failure mode for the new commands when the key is missing: exit non-zero with `chi consult: ANTHROPIC_API_KEY is not set — run \`chi init --provider=claude\` or export the env var`. | — |

**Implementation guard for #8** (mirrored as an acceptance criterion):
the key check lives inside `src/orchestrator/claude-agent.ts` at the
first `query()` call — not in `loadPersistedConfig()` or any boot path.
A unit/integration test must prove that `chi status` / `chi commit`
/ `chi doctor` succeed in an environment where only the cura credentials
are present, no claude key, the SDK module not even importable. The
existing [src/config.ts](../../src/config.ts) gains the
`anthropic_api_key` → `ANTHROPIC_API_KEY` mapping but does **not** treat
the key as required.

## Acceptance criteria for G1 → G2 — **all met 2026-05-11**

- [x] User has approved the three SDK / scope / seam choices captured in
      the "Open questions — proposed defaults" table above. *(2026-05-11)*
- [x] User has approved the five remaining defaults (#4–#8), with #8
      refined to "key blocks **only** claude-agent-backed commands; all
      pre-existing commands keep working without it." *(2026-05-11)*
- [x] H1, H2, H3 stand — no falsifying evidence raised in review.
      Verification of each will happen in EXP-002 (prototype run).
- [x] Risks R1–R5 acknowledged; mitigations agreed. R3 (permission-mode
      footgun) is the highest residual risk and gets re-tested in EXP-002.
- [x] Scope (in/out) signed off. `chi gate` / `chi approve` deferred to
      CTX-003 confirmed.
- [x] ADR-007 draft reviewed and approved alongside this plan.
- [x] Frontmatter flipped to `status: approved` / `decided-by: chevp` /
      `approved-by: chevp` / `approved-at: 2026-05-11` on both this plan
      and ADR-007.

**G1 closed. Next: EXP-002** (Exploration-A, problem-exploration mode).
See [EXP-002-h2-orchestrator-prototype.md](EXP-002-h2-orchestrator-prototype.md).

Once all checked, this plan moves to **EXP-002** (Exploration-B:
prototype `Orchestrator.run()` end-to-end on a single command, then
decide between two candidate API surfaces — the one specified here vs.
a streaming-first variant — before committing to PRD-003).
