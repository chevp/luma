---
id: PROP-004
type: PROP
status: open
proposed-by: chevp
proposed-at: 2026-04-29
---

# PROP-004 — `chi commit` interactive git-warnings fixer

## What

Port `che-cli/lib/che/git/warnings.sh`: after `git add -A` emits warnings
(CRLF, ignored files, file-mode, etc.), feed them to the active provider,
parse a `COMMAND: git config ...` suggestion, allowlist-check it, and offer
the user a y/N to apply.

## Why

Same rationale as PROP-003 — saves a context switch on common warnings.

## Notes

- Allowlist must be strict: only `git config [--local|--global] key value`.
  No pipes, no command substitution, no other commands.
- Behavior gate: `CHI_FIX_WARNINGS=0` opts out (mirrors che).
