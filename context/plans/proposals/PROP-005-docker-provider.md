---
id: PROP-005
type: PROP
status: open
proposed-by: chevp
proposed-at: 2026-04-29
---

# PROP-005 — Docker-backed AI provider

## What

A `docker` provider option that wraps a local Ollama-compatible server running
inside a container (e.g. `ollama/ollama` image). Selectable via
`CHI_PROVIDER=docker`.

## Why

che-cli has a docker dependency check but no docker AI provider. A
container-backed runtime is useful on Windows boxes where native ollama setup
is finicky.

## Notes

- Likely shares 90% of `src/provider/ollama.ts` (HTTP client to a local port).
- May also expose `chi init docker` to provision the container.
- Out of scope until a user actually asks for it.
