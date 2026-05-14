---
id: PROP-002
type: PROP
status: open
proposed-by: chevp
proposed-at: 2026-04-29
---

# PROP-002 — Self-update on successful `chi ship`

## What

Port `che-cli/lib/che/self_update.sh`: on a successful top-level `chi ship`
invocation (only at the top level — not inside a recursive submodule ship),
check the chi repo's hash against the latest on origin/main and prompt the
user to re-run `chi reinstall` if there's a newer version.

## Why

Keeps `chi` current without a separate update step. che-cli ships with this;
chi doesn't yet, so a user who installs once and never `git pull`s will drift.

## Notes

The check should be quiet on no-op (no fetch noise during a normal ship) and
opt-out via `CHI_NO_UPDATE_CHECK=1`.
