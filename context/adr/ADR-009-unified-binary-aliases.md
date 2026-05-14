---
id: ADR-009
type: ADR
status: accepted
proposed-by: ai
proposed-at: 2026-05-11
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-11
supersedes: —
related: —
---

# ADR-009: chi is the single binary — `che` and `jan` are bin aliases

## Status
Accepted (2026-05-11).

## Context

Three repositories historically shipped overlapping developer CLIs:

- [`che-cli`](https://github.com/chevp/che-cli) — Bash/Python original.
- `jan-cli` — variant of the same CLI.
- `chi` (this repo) — TypeScript port of `che-cli` with the full command
  set (status, commit, ship, flow, done, issue, explain, init, update,
  config, doctor, workflow, run).

Every improvement made to `chi` (e.g. the new `chi update` summary with
old → new version + commit-range listing) had to be re-implemented in
two other codebases to remain visible to the user. After observing
`che update` print only `changed 2 packages in 4s` while `chi update`
already had the new summary, the cost of maintaining three near-identical
codebases is no longer paying for itself.

The wrapping mechanism for this consolidation is already in
[src/identity.ts](../../src/identity.ts) — `BIN_NAME` derives from
`basename(process.argv[1])` (or `CHI_INVOKED_AS`), so help text, error
prefixes, and the status header present as whatever name the binary was
invoked under.

## Decision

1. **chi declares all three names as bin entries.**
   [package.json](../../package.json):

   ```json
   "bin": {
     "chi": "bin/chi",
     "che": "bin/chi",
     "jan": "bin/chi"
   }
   ```

   `npm install -g chi` therefore creates three symlinks in the global
   bin directory, all pointing at the same launcher.

2. **Identity is preserved per-invocation, not per-install.**
   `identity.ts` reads the basename of `process.argv[1]`, which is the
   symlink the user typed. `chi update` says "chi update", `che update`
   says "che update", `jan update` says "jan update" — same code, same
   binary, three faces.

3. **`chi update` updates chi regardless of invocation name.** The
   `REMOTE = "github:chevp/chi"` constant is intentional. When invoked
   as `che`, `realpathSync(process.argv[1])` resolves through the
   symlink to chi's `bin/chi`, `findPackageRoot` walks up to chi's
   `package.json`, and the version diff in the summary block reflects
   chi's version.

4. **`che-cli` and `jan-cli` are deprecated.** They are no longer the
   source of any behaviour the user sees on `che …` / `jan …`. The
   repos may be archived, left as-is for historical reference, or
   reduced to a one-line README pointing at chi — that decision is out
   of scope here.

5. **Migration is explicit.** A user who already has `che-cli` and/or
   `jan-cli` installed globally must uninstall them before
   `npm install -g github:chevp/chi`, otherwise npm refuses to overwrite
   the existing `che` / `jan` symlinks (or worse, silently overwrites
   them depending on the npm version):

   ```sh
   npm uninstall -g che-cli jan-cli
   npm install -g github:chevp/chi
   ```

## Alternatives

### Alternative A: Keep `che-cli` and `jan-cli` as thin shim scripts

Each repo becomes a 3-line shell wrapper:
`exec chi "$@"` (with `CHI_INVOKED_AS=che` exported).

- **Pros:** No global-bin conflict at install time — `che-cli` still
  owns `che` on disk, it just delegates.
- **Cons:** Three repos, three release flows, three places to update
  the wrapper if chi's invocation contract ever changes. The
  consolidation premise (one source of truth) is only partially honoured.
  Rejected.

### Alternative B: A single `chi <subcommand>` namespace, drop `che` / `jan`

Users would type `chi ship` only.

- **Pros:** Simplest mental model.
- **Cons:** Breaks every shell history, alias, and muscle memory built
  around `che` / `jan`. The user explicitly asked for the three names
  to keep working — this contradicts intent. Rejected.

### Alternative C: Status quo — port every chi change back to `che-cli` and `jan-cli`

- **Pros:** No migration cost; users keep installing what they have.
- **Cons:** The observed cost of this option triggered this ADR.
  Rejected.

## Consequences

### Positive

- One codebase to improve. The `chi update` summary block (this
  session's preceding change) is automatically available as
  `che update` and `jan update`.
- The `Provider`, `Orchestrator`, and command-dispatch layers stay
  exactly where they are — this ADR is a packaging decision, not a
  runtime one.
- `identity.ts`'s purpose becomes load-bearing instead of speculative.

### Negative

- Installation now has a documented prerequisite step
  (`npm uninstall -g che-cli jan-cli`). Mitigation: README's "Update"
  section calls it out; first-run-after-migration of `chi doctor` could
  detect a residual `che-cli` install (separate work, not blocking).
- The `che-cli` and `jan-cli` repos become stale unless explicitly
  archived. Mitigation: out of scope here, but a short notice in each
  README pointing at chi is recommended.

### Risks

- **npm install conflict on first migration.** If a user runs
  `npm install -g github:chevp/chi` without uninstalling `che-cli` /
  `jan-cli` first, npm's behaviour varies by version — newer npm
  refuses, older npm overwrites silently. The README must be explicit;
  a future `chi doctor` check can warn proactively.
- **Drift between `BIN_NAME` and `package.json#name`.** Anything that
  reads `package.json` (e.g. the update summary's version field) sees
  `"chi"`, but the user typed `che`. Mitigation: this is intentional —
  the version belongs to chi (the implementation), the invocation
  prefix belongs to the user's habit. The summary block can read both
  if confusion is reported.
