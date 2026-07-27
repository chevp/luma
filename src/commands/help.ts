import { BIN_NAME, BIN_TAG } from "../identity.js";

function text(): string {
  const n = BIN_NAME;
  return `${n} — collection of small CLI utilities (Node.js port of che-cli)

Usage: ${n} <command> [args]

Commands:
  commit              stage all + AI-generated commit message (+ optional push)
  ship                add + commit + push, recursively into submodules
                      (init missing submodules, ff-pull on a branch);
                      in flow mode: push -u + open/update draft PR
  flow <branch>       start a flow branch (pull base, checkout new, mark repo)
  work <name>         create a parallel git worktree (${n}/<name> branch);
                      '${n} work list|rm|cd' manage existing worktrees
  done                finish active flow: gh pr merge --squash --auto, back to base
                      (in a worktree: removes the worktree after merge)
  release [version]   create + push annotated vX.Y.Z tag (defaults to
                      ./package.json version); a 'on: push: tags' workflow
                      can then publish a GitHub Release
  issue [sub] [args]  open / list / close / fix GitHub issues (AI-drafted body);
                      '${n} issue [text]' is shorthand for '${n} issue create [text]';
                      '${n} issue fix <n> [hint]' cuts a fix branch + starts a
                      framework-driven Claude session (CTX → EXP → PRD)
  explain [question]  ask the active LLM to diagnose the last ${n} ship/commit failure
                      (read-only — prints a suggested command, never executes)
  consult [question]  multi-turn AI consultation via the claude-agent orchestrator
                      (defaults to read-only — Read/Glob/Grep + chi.* tools;
                      add --write for Edit/Write, --dangerously-allow-bash for Bash)
  plan <sub> [args]   scaffold framework artifacts:
                      '${n} plan new <CTX|EXP|PRD|PROP|ADR> "<title>"'
                      '${n} plan list [<type>]'
  init                provision local ollama (verify binary, start server, pull model)
  run <name>          execute a workflow from .che/workflows/<name>.yml
                      (alias for: ${n} workflow run <name>)
  workflow <sub>      list / show / run workflows from .che/workflows/
  <trigger> [args]    any workflow with 'trigger: <name>' in its YAML can be
                      run as '${n} <name>' — shadows the built-ins above
  update              update ${n} itself (workspace clone or global install)
  status              git status + ${BIN_TAG} config (provider, model, env)
  config [key] [val]  view or change persistent settings (~/.chi/config);
                      e.g. '${n} config provider claude-code'
  doctor [target]     verify deps and providers (git, gh, docker, ollama,
                      claude-code, copilot, workflow)
  repo [--fix]        diagnose repo hygiene (missing .gitignore, tracked build
                      artifacts, broken gitlinks); --fix applies fixes
  inspect             repo snapshot across the workspace (LOC, files, deps,
                      complexity, scale, public/private) — like git diff --stat
  serve [--port N]    start the local web console (chat UI over cura)
  help                show this message

Run '${n} <command> --help' for command-specific options.
`;
}

export async function run(_argv: string[]): Promise<number> {
  process.stdout.write(text());
  return 0;
}
