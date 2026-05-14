---
id: PROP-003
type: PROP
status: open
proposed-by: chevp
proposed-at: 2026-04-29
---

# PROP-003 — `chi ship` interactive conflict resolution via claude

## What

Port `che-cli/lib/che/git/conflicts.sh`: when `chi ship`'s pre-push rebase
produces conflicts, invoke `claude -p` per file with the file content + the
incoming commit log; show a diff of the proposed resolution; offer the user
[a]ccept / [o]urs / [t]heirs / [e]dit / [r]etry+hint / [s]kip / [q]uit.

## Why

Today `chi ship` aborts the rebase and surfaces conflicts manually. che has
this resolver and it materially shortens conflict handling.

## Notes

- Calls `claude -p` directly (not via `providerSmartGenerate`) — local Ollama
  models are too weak for non-trivial conflicts.
- Needs careful TTY handling (read from `process.stdin`, restore cursor on
  Ctrl-C, etc.). Likely warrants a small `src/menu.ts` helper.
- Behavior gate: `CHI_RESOLVE_CONFLICTS=0` opts out.
