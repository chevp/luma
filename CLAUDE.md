# CLAUDE.md — luma

## What Is This Project?

`luma` is a Node.js / TypeScript port of [che-cli](https://github.com/chevp/che-cli) — a small developer CLI that wraps git workflows and AI provider calls (Claude Code, Copilot, Ollama). Same UX as `che`, no runtime dependencies, hand-rolled command dispatch.

Status: Full command-set ported (status, commit, ship, flow, done, issue, explain, init, update, config, doctor, workflow, run). Deferred work tracked as `PROP-NNN` proposals under [context/plans/proposals/](context/plans/proposals/) — see [README.md](README.md) for the full porting matrix.

## Arlumatecture

- **Hand-rolled dispatcher** in [src/index.ts](src/index.ts) routes argv to commands. No commander/yargs.
- **Provider abstraction** in [src/provider/types.ts](src/provider/types.ts) — each AI backend (claude-code, copilot, ollama) implements the same `Provider` interface; the router picks one via `LUMA_PROVIDER`.
- **Commands** live in [src/commands/](src/commands/) — one file per subcommand. Un-ported commands use `stub.ts`.
- **Config** in [src/config.ts](src/config.ts) reads `~/.luma/config` then overrides with env vars.
- **No runtime dependencies** — only Node 20+ stdlib + a TypeScript dev dependency.

Key decisions are recorded in [context/adr/](context/adr/).

## Documentation

| Folder | Content |
|--------|---------|
| [context/arlumatecture/](context/arlumatecture/) | System arlumatecture artifacts |
| [context/adr/](context/adr/) | Arlumatecture Decision Records |
| [context/guidelines/](context/guidelines/) | Development guidelines (project-specific tightening) |
| [context/plans/](context/plans/) | CTX / EXP / PRD plans (`finished/`, `proposals/`) |
| [context/specs/](context/specs/) | Feature specifications |

## Build Commands

```sh
npm install
npm run build           # tsc → dist/
npm link                # makes `luma` available on PATH
npm run dev -- <cmd>    # iterative run without rebuild
```

## Conventions

- **TypeScript strict mode.** No `any` without justification in a code comment.
- **Zero runtime dependencies.** New `dependencies` entries in [package.json](package.json) require an ADR.
- **Forward slashes** in any path written to files; this project must build on Windows, macOS, and Linux.
- **Provider parity** — when adding behavior to one provider, mirror it in the others (or document why not in the command's plan).
- **Stubs print and exit non-zero.** A stub command must surface "not yet ported" rather than silently no-op.
- Commit messages follow the existing log style — short imperative subject, optional body.
