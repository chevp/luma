---
id: PROP-009
type: PROP
status: open
proposed-by: chevp+ai
proposed-at: 2026-07-31
---

# PROP-009 — declarative toolchain manager (`setup`/`doctor`/`fix` + `.luma/toolchain.yml`)

## Problem Statement

Setting up a game/graphics dev machine (CMake, Vulkan SDK, Java, Android
SDK/NDK, Blender, Node, git, Ollama, VS Code) is a manual checklist today.
The user wants `luma` to know about these tools the way `up`/`down` already
know about the workspace's Docker stacks: a declarative manifest describing
the desired state, one command to converge the machine to it, and a doctor
check that reports drift at any time.

In one sentence: **turn `luma setup` into a machine-local, dependency-free
alternative to mise/asdf for this workspace's toolchain, driven by a
`.luma/toolchain.yml` manifest.**

## Design

- **Manifest**: `<workspace-root>/.luma/toolchain.yml` (override via
  `LUMA_TOOLCHAIN_FILE`), parsed with the existing hand-rolled YAML parser
  (`src/yaml.ts`) — no new dependency. Shape:

  ```yaml
  sdk:
    cmake: latest
    vulkan: latest
    java: "21"
    android: latest
    blender: "4.6"
    node: "24"
    ollama: true
  tools:
    vscode: true
    git: true
  ```

- **Installer interface** (`src/installers/types.ts`): every tool implements
  `check(desired)`, `install(desired)`, optional `fix(desired)`, and
  `hint(os)` for manual instructions. Registered in
  `src/installers/registry.ts`.

- **Commands**:
  - `luma setup [tool...] [--dry-run]` — converge to the manifest's declared
    version for each tool (install if missing, upgrade if version drifted).
  - `luma doctor [cmake|vulkan|java|android|blender|node|vscode|...]` —
    per-tool check, reusable outside of the manifest; `luma doctor all` adds
    a manifest-drift section when `.luma/toolchain.yml` exists.
  - `luma fix [tool...]` — repairs only missing/broken tools; deliberately
    does **not** force a version upgrade on an already-installed tool (that's
    `setup`'s job) so it's safe to run reflexively.

- **Automated install** uses winget (Windows) / Homebrew (macOS) / apt-get
  (Linux, best-effort) via the existing `execInherit` spawn helper — no HTTP
  client or package-manager dependency added (ADR-003).

## Known limitations (by design, not oversight)

`android`, `vulkan`, and `blender` are **check: full, install: best-effort**:
- Vulkan SDK has no reliable macOS package and only a runtime-only apt
  package; `install()` uses winget where possible and otherwise prints the
  LunarG download steps.
- Android SDK/NDK requires interactive license acceptance
  (`sdkmanager --licenses`) that cannot be scripted safely; `install()` gets
  Android Studio onto the machine where a package exists, then always prints
  the `sdkmanager` follow-up commands.
- Blender has no apt package on most distros; `install()` falls back to
  printing `snap install blender --classic` / tarball instructions on Linux.

`luma update` (self-update + workspace git recovery) and `luma clean` are
**not** part of this manifest system — `update` was already a different,
established command; re-running `setup` is the toolchain "update to declared
version" path instead. `clean` (cache/artifact pruning) has no clear spec yet
and is deferred to a future proposal.

## Files

`src/toolchain.ts`, `src/installers/{types,report,registry,pkgmanagers,git,
node,cmake,java,vscode,ollama,vulkan,blender,android}.ts`,
`src/commands/{setup,fix}.ts`, `src/commands/doctor.ts` (extended),
`src/index.ts` + `src/commands/help.ts` (registration).
