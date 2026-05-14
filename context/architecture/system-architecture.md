# System Architecture — chi

> Snapshot at framework installation (2026-04-29). Update as the system evolves; do not let this document drift.

## Purpose

`chi` is a TypeScript port of `che-cli`. It provides a single binary (`chi`) that wraps git workflows and AI provider calls. Its goals:

- Same UX as `che` so both can coexist on a developer machine.
- Zero runtime dependencies — only Node 20+ stdlib and a TS dev toolchain.
- Hand-rolled command dispatch for clarity (no commander/yargs).

## Layers

```
┌──────────────────────────────────────────────────────────┐
│  bin/chi  +  bin/chi.cmd       (shims → dist/index.js)   │
└──────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  src/index.ts            (dispatcher: argv → command)    │
└──────────────────────────────────────────────────────────┘
        │                     │                    │
        ▼                     ▼                    ▼
┌─────────────┐       ┌────────────────┐   ┌─────────────────┐
│ src/commands│       │  src/git/      │   │ src/provider/   │
│  help, status,      │  porcelain     │   │  claude-code |  │
│  commit*, ship*,    │  ahead/behind  │   │  copilot     |  │
│  flow*, …           │  recent log    │   │  ollama         │
└─────────────┘       └────────────────┘   └─────────────────┘
        │                                           │
        └──────────► src/config.ts ◄────────────────┘
                    (env > ~/.chi/config)
                    src/platform.ts (darwin|windows|wsl|linux)
                    src/ui.ts       (ANSI + section/kv printers)
```

(* = stub in Phase 1; see [README.md](../../README.md) porting matrix.)

## Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| Dispatcher | [src/index.ts](../../src/index.ts) | Parse argv, route to a `CommandRunner`, surface errors |
| Config | [src/config.ts](../../src/config.ts) | Load `~/.chi/config`, allow env-var override |
| Platform | [src/platform.ts](../../src/platform.ts) | Detect `darwin` / `windows` / `wsl` / `linux` |
| UI | [src/ui.ts](../../src/ui.ts) | ANSI colors + section / kv printers |
| Git | [src/git/index.ts](../../src/git/index.ts) | Wrappers over `git` porcelain |
| Provider | [src/provider/](../../src/provider/) | `Provider` interface + per-backend implementations |
| Commands | [src/commands/](../../src/commands/) | One file per subcommand; `stub.ts` for un-ported ones |

## External Dependencies

- **Node 20+** runtime (uses native fetch, ESM, built-in test runner).
- **git** binary on PATH for any git command.
- **Provider backends** invoked via CLI / HTTP:
  - `claude-code` — local CLI managed by Anthropic
  - `copilot` — GitHub CLI extension
  - `ollama` — HTTP at `http://localhost:11434` by default

## Data & Configuration

- Persistent defaults: `~/.chi/config` (key=value).
- Runtime overrides: env vars (`CHI_PROVIDER`, `CHI_OLLAMA_HOST`, `CHI_OLLAMA_MODEL`, `CHI_MAX_DIFF_CHARS`, `CHI_FORCE_CLAUDE_CODE`, `CHI_CONFIG_FILE`).
- No persistent state owned by `chi` itself beyond that config file.

## Cross-Platform Concerns

- Forward slashes in any path written to a file or printed to a user.
- No hardcoded drive letters; use `os.homedir()` / `path.join`.
- Shims for both POSIX (`bin/chi`) and Windows (`bin/chi.cmd`).

## Reference

Decision history lives in [../adr/](../adr/). The framework lifecycle (Context → Exploration → Production) is described upstream at <https://chevp.github.io/chevp-ai-framework/chevp-ai-framework.md>.
