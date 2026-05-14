---
id: PROP-007
type: PROP
status: promoted
proposed-by: chevp+ai
proposed-at: 2026-05-02
promoted-to: CTX-002-ai-orchestration-providers.md
promoted-at: 2026-05-11
---

> **Promoted** to [CTX-002 — AI-Orchestration Providers & Framework-aware
> CLI](../CTX-002-ai-orchestration-providers.md) on 2026-05-11. The
> chevix-agents routing question (vendoring A–D) is *not* part of CTX-002
> v1 scope — CTX-002 ships `chi consult` against the Anthropic Agent SDK
> directly. Agent-name routing returns as a follow-up once CTX-002 reaches
> G3.

# PROP-007 — `chi consult` / agent-driven situational awareness

## What

A new top-level command (working name `chi consult` — alternatives:
`chi ask`, `chi advise`) that routes a natural-language question to an
agent from [chevix-agents](https://github.com/chevp/chevix-agents) and
returns the agent's answer. Examples:

```sh
chi consult "what am I working on right now?"
chi consult "where are the hardest open problems in this repo?"
chi consult --agent=planner-agent "should I split this PR?"
```

Optional: when the active agent declares an `ask-user-question` capability,
chi forwards the agent's clarifying questions back to the terminal via
the Claude SDK (or the configured provider's equivalent), then resumes the
agent with the user's answer.

Routing model — two layers:
1. **Default**: pick agent by capability (e.g. `code.review`, `meta.plan`,
   `project.progress`) inferred from the question.
2. **Override**: `--agent=<name>` skips routing and runs the named agent.

## Why

- The user runs ~200 repos across category folders and needs a one-stop
  way to ask "what am I working on?", "where are the blockers?", "what
  should ship next?" without manually scanning git logs / PR boards / TODOs.
- chevix-agents already encodes those perspectives (planner-agent,
  project-progress-agent, critic-agent, etc.) — chi should *route* to
  them, not re-implement them.
- Keeping the agent definitions in chevix-agents (Markdown manifests)
  preserves single-source-of-truth: one update there propagates to chi
  and any other consumer.

## Notes

- **No agent logic inside chi.** chi is a router + adapter: it locates
  agent.md, hands the system prompt + question to the active provider,
  streams the answer back. Same `Provider` abstraction as `chi commit`.
- **Vendoring strategy — open question (decide before G1):**
  - **A: Git submodule** — `chi/vendor/chevix-agents`. Reproducible,
    auto-cloned with `--recurse-submodules`. Pinned SHA per chi commit.
  - **B: Sibling lookup** — chi resolves agents at
    `<workspace-root>/misc/chevix-agents` by convention. Zero impact on
    chi repo. Breaks for users outside this workspace layout.
  - **C: Configurable resolver** — `chi config chevix_agents_path`
    with sibling-lookup as default fallback. Most flexible, one extra
    setting.
  - **D: Remote-only** — fetch agent.md via HTTPS at call time
    (chevix-agents already supports this, see `docs/https-loading.md`).
    Pros: no local copy, always current. Cons: requires network on every
    call; cache layer needed.
- **Question→agent routing:** options for the picker:
  - simple: keyword lookup against `registry.md` capabilities table
  - smart: LLM call to a `meta.route` agent (router-agent already exists
    in chevix-agents) — costlier, but matches the existing pattern.
- **ask-user-question loop:** requires bidirectional channel with the
  provider. Claude Code CLI supports this via the SDK; copilot/ollama
  paths need investigation. Likely behavior gate
  `CHI_CONSULT_INTERACTIVE=1`.
- **Out of scope (future PROPs):**
  - Agent installation / management (`chi agent install <name>` etc.)
  - Workspace-wide consult ("ask all repos in workspace") —
    intersects with PROP-006.
  - Caching / offline mode.

## Status / next step

Skeleton only. Before G1 this needs:
- Decision on vendoring (A–D above).
- ≥ 2 hypotheses with kill criteria (e.g. "router-agent picks the right
  capability ≥ 80 % of the time on a 20-question fixture").
- ≥ 3 expensive risks (provider rate-limit interaction with
  ask-user-question loop, agent.md schema drift, cross-repo question
  scope ambiguity).
- ADR sketch — likely shares ground with PROP-006's ADR-004.

Currently parked behind PROP-006 (workspace-ship), per chevp 2026-05-02.
