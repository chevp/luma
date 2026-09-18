import { BIN_NAME, BIN_TAG } from "../identity.js";
function text() {
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
  issue [sub] [args]  open / list / close GitHub issues (AI-drafted body);
                      '${n} issue [text]' is shorthand for '${n} issue create [text]'
  explain [question]  ask local ollama to diagnose the last ${n} ship/commit failure
                      (read-only — prints a suggested command, never executes)
  init                provision local ollama (verify binary, start server, pull model)
  login <provider>    authenticate an LLM provider (currently: claude — GitHub
                      Copilot device flow); sets provider=claude on success
  update              update ${n} itself (workspace clone or global install)
  status              git status + ${BIN_TAG} config (provider, model, env)
  config [key] [val]  view or change persistent settings (~/.chi/config);
                      e.g. '${n} config ollama_model qwen2.5:7b'
  doctor [target]     verify deps and providers (git, gh, ollama, claude,
                      cmake, vulkan, java, android, blender, node, vscode)
  setup [tool...]     install/upgrade the toolchain declared in
                      .luma/toolchain.yml (--dry-run to preview)
  fix [tool...]       repair only missing/broken tools from
                      .luma/toolchain.yml (never forces version upgrades)
  repo [--fix]        diagnose repo hygiene (missing .gitignore, tracked build
                      artifacts, broken gitlinks); --fix applies fixes
  inspect             repo snapshot across the workspace (LOC, files, deps,
                      complexity, scale, public/private) — like git diff --stat
  serve [--port N]    start the local web console (chat UI over cura)
  up [stack...]       start the workspace Docker stacks from .luma/stacks.json
                      (each as its own compose project; --build, --attach)
  down [stack...]     stop those stacks (-v also removes named volumes)
  secrets [options]   push a dotenv file as GitHub Actions secrets across the
                      repos in .chi-workspace ('${n} secrets --help' for options)
  help                show this message

Run '${n} <command> --help' for command-specific options.
`;
}
export async function run(_argv) {
    process.stdout.write(text());
    return 0;
}
//# sourceMappingURL=help.js.map