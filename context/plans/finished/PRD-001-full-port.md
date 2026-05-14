---
id: PRD-001
type: PRD
status: done
proposed-by: chevp
approved-by: chevp
approved-at: 2026-04-29
completed-at: 2026-04-29
supersedes: —
implements: che-cli parity
evidence:
  hypothesis: A 1:1 TS port of che-cli's command surface can be implemented
              without runtime dependencies, by replacing curl→fetch,
              jq→native JSON, yq→hand-rolled minimal YAML, and shelling out
              to git / gh / claude / copilot / ollama unchanged.
  result:     All che-cli shell scripts read end-to-end. The interfaces are
              small (status, commit, ship, flow, done, issue, explain, init,
              reinstall, config, doctor, workflow {list,show,run}) and only
              workflow.yml parsing is novel. A minimal YAML subset parser
              (top-level keys, lists, nested maps, simple scalars) covers
              every example workflow shape under .che/workflows/.
  reasoning:  The constraint that survives the port is "no inline bash" in
              workflows (steps reference scripts), so the YAML parser can
              stay tiny. Everything else is glue around child processes.
---

# PRD-001 — Full chi port of che-cli

## Goal

Reach parity with `che-cli` (shell) in `chi` (TypeScript): every command listed in
[README.md](../../README.md)'s porting matrix transitions from "stub" to "done",
preserving CLI UX byte-for-byte where it matters (status output, prompts, error
messages, exit codes).

## In scope

Production of the following modules / commands:

| Area               | Files                                              |
|--------------------|----------------------------------------------------|
| Shared helpers     | `src/spawn.ts`, `src/prompt.ts`, `src/spinner.ts`, `src/frontmatter.ts`, `src/yaml.ts` |
| Provider generate  | `src/provider/{claude-code,copilot,ollama}.ts` (extend `generate()` + smart router) |
| Provider router    | `src/provider/index.ts` (smart-generate, ensure-running, escalation) |
| Git helpers        | `src/git/index.ts` (push-with-recovery, conflicts, warnings, ff-pull) |
| Status full        | `src/commands/status.ts` (submodules + GitHub issues/PRs + plans) |
| Commit / ship      | `src/commands/{commit,ship,flow,done}.ts`         |
| Issue              | `src/commands/issue.ts`                            |
| Explain            | `src/commands/explain.ts`                          |
| Init / Reinstall   | `src/commands/{init,reinstall}.ts`                 |
| Config / Doctor    | `src/commands/{config,doctor}.ts`                  |
| Workflow           | `src/commands/workflow.ts`, `src/workflow/{loader,run}.ts` |
| Help / dispatcher  | `src/commands/help.ts`, `src/index.ts`             |

## Out of scope

- `installer/` (PowerShell + bash installer) — separate PRD.
- `self_update.sh` (called from `che ship` after success) — opt-in feature, separate PRD.
- `docker/` provider checks — kept as a `chi doctor docker` target only (no docker provider for AI).
- Workflow `trigger:` shadowing built-ins from the dispatcher — implemented but uses the same minimal YAML parser; complex `tag` queries (`.trigger | tag`) supported only for `string` vs `list`.

## Acceptance criteria

1. `npm run build` succeeds with no TS errors.
2. `chi help` shows the full command list (no "not yet ported").
3. `chi status` (this repo, dirty tree) renders the same sections as `che status` (chi-cli, git, recent commits, plans). Submodule + issue/PR sections appear when applicable.
4. `chi config provider claude-code` writes `~/.chi/config`; `chi config provider` reads it back; `chi config --unset provider` removes it.
5. `chi doctor` runs all checks; `chi doctor git`, `chi doctor provider`, `chi doctor workflow` each work standalone.
6. `chi commit -n` (dry-run) generates a commit message via the active provider and prints it without committing.
7. `chi flow feat/x` writes `.git/chi-flow`; `chi ship` (in flow mode) commits + pushes + opens a draft PR; `chi done` merges and cleans up.
8. `chi issue list`, `chi issue create -n` work against a GitHub repo with `gh` authenticated.
9. `chi explain --show` reads `.git/chi-last-error.log`; `chi explain "<q>"` calls the provider and prints DIAGNOSIS/COMMAND/WHY.
10. `chi workflow list` / `show` / `run` parse a sample `.che/workflows/<name>.yml` (note: keep `.che/workflows/` path so chi reuses the same workflow files as che).
11. `chi run <name>` is an alias for `chi workflow run <name>`.

## Kill criteria

Abandon and revisit the plan if any of:

- The minimal YAML parser cannot represent existing workflow files in this workspace (e.g. anchor/alias use, multi-doc, complex tags). Fallback: keep parity with che by shelling out to a bundled `yaml_get.py` (then ADR-003 needs an exception ADR for python).
- `claude -p` / `copilot -p` / `ollama` cannot be invoked from Node `child_process` cleanly (e.g. Windows quoting issues). Fallback: write a thin `bash -c '...'` wrapper that invokes the provider with stdin piping intact.
- Interactive prompts on Windows console don't read `/dev/tty`. Fallback: read from `process.stdin` with TTY check; if no TTY, treat as non-interactive (skip prompt, default-no).

## Naming compatibility

chi reads the **same** marker / log / config locations as che where appropriate:

- `~/.chi/config` (chi's own config) — env vars `CHI_*`.
- `.git/chi-flow` (chi's own marker — both `che` and `chi` may operate on the same repo without colliding).
- `.git/chi-last-error.log` (chi's own log).
- `.che/workflows/*.yml` (**shared** with che — workflows are repo-scoped artifacts and shouldn't fork by tool).

## Out-of-scope items captured as proposals

- PROP-001: Installer scripts (`install.sh`, `install.ps1`) for chi.
- PROP-002: Self-update for chi (post-ship hash check).
- PROP-003: Docker AI provider (none today — che doesn't expose one either).
