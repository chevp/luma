---
id: ADR-005
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-02
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-02
supersedes: —
---

# ADR-005: Bundled Workflow Fallback

## Status
Accepted.

## Context

`chi issue fix <N>` delegates to the workflow runner via
`chi workflow run issue-fix`. The runner walks up from cwd looking for
`.che/workflows/<name>.yml` (see [src/workflow/loader.ts](../../src/workflow/loader.ts)
`findWorkflowsDir`). Until now, every consumer repo had to ship its own
`.che/workflows/issue-fix.yml` *and* its own `.che/scripts/issue-fix.sh`, even
though chi's own repo already carries reference copies of both.

Observed in the wild: running `chi issue fix 127` in `chevp/cura` failed with
`workflow not found: issue-fix (looked in .../cura/.che/workflows)`. cura has a
`.che/workflows/` directory full of project-specific workflows
(`demo.yml`, `release-desktop.yml`, etc.) but no `issue-fix.yml` — and there is
no good reason for it to: that workflow is a generic chi capability, not a
cura-specific automation.

## Decision

`resolveWorkflow(name, cwd)` gains a **bundled fallback**:

1. **Per-repo override (unchanged).** Walk up from `cwd` for
   `.che/workflows/<name>.{yml,yaml}`. If found, use it.
2. **Bundled fallback (new).** Otherwise, look in
   `<chi-install-root>/.che/workflows/<name>.{yml,yaml}`. If found, return it
   with `builtin: true`.
3. **Error.** Throw only if neither resolves.

Per-repo always wins, so users can override any built-in workflow by dropping a
same-named file into their repo's `.che/workflows/`.

The chi install root is derived via
`dirname(dirname(dirname(fileURLToPath(import.meta.url))))` from the loader
file. Both compiled (`<root>/dist/workflow/loader.js`) and dev
(`<root>/src/workflow/loader.ts` via tsx) layouts place the loader two
directories below the install root, so the same calculation holds in both
cases.

### Runner behavior for bundled workflows

[src/commands/workflow.ts](../../src/commands/workflow.ts) `cmdRun` previously
ran `process.chdir(resolved.root)` so step `script:` paths could be relative
to `.che/`. For bundled workflows this is wrong: the script is meant to operate
on the user's repo (e.g. `.che/scripts/issue-fix.sh` calls `chi flow` to cut a
branch in cura), not on chi's bundle. The runner therefore:

- **Skips** `chdir` when `resolved.builtin === true`.
- **Resolves** each step's `script:` to an absolute path under
  `resolved.root` (the bundle).
- Tags the workflow header with `(built-in)` so users see which copy ran.

Per-repo workflows behave exactly as before.

### Install / packaging implications

`npm link` (the only supported install today; see
[scripts/reinstall.sh](../../scripts/reinstall.sh)) symlinks the whole repo, so
`.che/workflows/` and `.che/scripts/` are reachable from the linked CLI without
any extra packaging step. If chi ever publishes to a registry, `package.json`
must add `.che/` to the `files` field; the loader's runtime contract
(`<install-root>/.che/workflows/<name>.{yml,yaml}`) is unchanged.

## Alternatives

### Alternative A: copy `issue-fix.yml` + `issue-fix.sh` into every consumer repo
- Pros: zero CLI change.
- Cons: every new chi user has to duplicate two files; updates to the workflow
  require N PRs across N repos; defeats the point of `chi` providing a generic
  "issue fix" UX. Reject.

### Alternative B: drop the workflow indirection — call the script directly from `cmdFix`
- Pros: simplest control flow; no resolver changes.
- Cons: removes the documented power-user override
  ([src/commands/issue.ts:593-594](../../src/commands/issue.ts#L593))
  ("yaml file owns the branch-cut + claude launch sequence so power-users can
  edit it without recompiling chi"). Reject — keeping the override is a
  deliberate UX choice.

### Alternative C: search `~/.chi/workflows/` as the fallback
- Pros: user-extensible without recompiling chi.
- Cons: introduces a third resolution path with its own update story; still
  doesn't solve the default-experience problem (a fresh user has nothing in
  `~/.chi/`). The bundled fallback already lets power users put files in
  `~/.chi/.che/workflows/` if they want — or, more honestly, in their
  per-repo `.che/`. Defer; reopen if a real demand surfaces.

### Alternative D: chdir to the user's cwd unconditionally, regardless of source
- Pros: uniform runner behavior.
- Cons: per-repo workflows declare scripts relative to their own root
  (`.che/scripts/foo.sh`); not chdir'ing breaks existing workflows in chi and
  cura both. Reject.

## Consequences

### Positive

- `chi issue fix <N>` works in any git repo on day one, with no per-repo
  setup. The original bug report (`cura`, issue #127) is fixed by this change
  alone — no edits needed in cura.
- Power users keep the per-repo override path (drop a same-named file in
  `.che/workflows/` to win).
- chi can grow new built-in workflows (e.g. `release.yml`, `triage.yml`) by
  adding them to `<chi>/.che/workflows/` without changing the loader contract.

### Negative

- chi now ships executable shell assets, not just compiled JS. The
  `npm link` install path handles this transparently today, but a future
  registry publish must include `.che/` in `package.json#files`. Captured as
  a doctor warning if `.che/` is missing at runtime (TODO; out of scope here).

### Risks

- **Path derivation fragility.** `bundleRoot()` assumes the loader sits two
  levels below the install root. Both `dist/workflow/loader.js` and
  `src/workflow/loader.ts` (via tsx) satisfy this. If the build layout
  changes (e.g. flat output in `dist/`), this breaks silently — the fallback
  just wouldn't fire and we'd be back to "workflow not found". Mitigation:
  the `(built-in)` tag in the runner header is a manual smoke test; a unit
  test asserting `bundleRoot()` resolves to a directory containing
  `.che/workflows/issue-fix.yml` would be cheap insurance, but no test
  harness exists in chi today (out of scope).
- **Power-user override discoverability.** A user who drops
  `.che/workflows/issue-fix.yml` into their repo and is surprised the bundled
  copy stopped running has the per-repo-wins behavior to thank. The runner
  header *does not* tag per-repo workflows, but the absence of `(built-in)`
  is the signal. Acceptable.
- **Bundle / per-repo drift.** The bundled `issue-fix.yml` and a stale
  per-repo override can diverge silently. Same story as ADR-004's "manifest
  drift" — a doctor check could compare hashes, but not worth building before
  someone hits it.

## Kill Criteria

Roll back this ADR (and revert to per-repo-only resolution) if any of:

- The `bundleRoot()` derivation fails on Windows or in a packaged install
  (`pkg`/`bun build`/etc.) and the workaround grows beyond ~20 lines.
- Two or more consumer repos report wanting per-repo `issue-fix.yml`
  divergence from the bundle that the override path can't express cleanly.
- A `~/.chi/workflows/` user-level fallback (Alternative C) is implemented and
  better serves the same use case — at which point the bundle becomes
  redundant and should be removed, not kept alongside.
