# Plans

Lifecycle artifacts produced during Context, Exploration, and Production.

| Subfolder | Contents |
|-----------|----------|
| [proposals/](proposals/) | `PROP-NNN-<title>.md` items pending human triage |
| [proposals/rejected/](proposals/rejected/) | Rejected proposals (kept for traceability) |
| [finished/](finished/) | Completed `CTX-NNN`, `EXP-NNN`, `PRD-NNN` plans |

Active plans (proposed / approved / in-progress) live at the top level of `plans/`. Move them to `finished/` when the corresponding gate (G3) has passed and the change is shipped.

Naming:
- `CTX-NNN-<title>.md` — Context phase plan
- `EXP-NNN-<title>.md` — Exploration phase plan
- `PRD-NNN-<title>.md` — Production phase plan
- `PROP-NNN-<title>.md` — Out-of-scope proposal awaiting triage

## Plans vs. GitHub issues

Plans and GitHub issues serve different roles and one does not replace the other:

- **Plans (this folder) are the source of truth for *design and decisions*.** They live in-repo, are diff-able, are referenced from ADRs and commits, and progress through the chevp-ai-framework gates (Context → Exploration → Production).
- **GitHub issues track the *continuous execution* of those plans.** Each non-trivial issue should reference the plan it advances (e.g. `plan: PROP-NNN-...`). The plan owns the *why* and the *what*; the issue owns the *when* and the *who*.
- **Challenger agents (or humans) initiate *new* plans by opening an issue first.** The issue captures the problem signal; if it is accepted, a `PROP-NNN` is drafted in [proposals/](proposals/) and the issue's body is updated to point at it. Issues without an underlying plan should stay narrow (bug reports, polish tasks, ADR fixups) — anything design-shaped is promoted to a plan.

Rule of thumb: if you cannot describe a piece of work as "advances `PROP/CTX/EXP/PRD-NNN` toward its next gate" or "narrow bug/polish on existing code", it likely needs a plan before it needs an issue.
