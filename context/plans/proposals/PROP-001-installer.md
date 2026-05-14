---
id: PROP-001
type: PROP
status: open
proposed-by: chevp
proposed-at: 2026-04-29
---

# PROP-001 — Installer scripts (`install.sh`, `install.ps1`)

## What

Mirror che-cli's installer:

- `install.sh` (bash) for macOS / WSL / Linux: clones the repo, runs `npm install
  && npm run build`, symlinks `bin/chi` into `/usr/local/bin/`.
- `install.ps1` (PowerShell) for Windows: clones, builds, copies to
  `$env:LOCALAPPDATA\chi`, prepends to `PATH`.

## Why

Today chi can only be installed via `git clone && npm install && npm link`,
which assumes a developer-class environment. The bash/PowerShell installers
make `chi` adoptable for users who don't already have npm on PATH (the
installers can fall back to bundled node binaries the way the che installers
will once that part of che ships).

## Out of scope

Bundled node runtime — only the install/link step. Bring-your-own node 20+.
