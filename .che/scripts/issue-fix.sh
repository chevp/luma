#!/usr/bin/env bash
# Glue script invoked by `.che/workflows/issue-fix.yml`.
# Args:
#   $1 = issue number
#   $2 = branch name (e.g. fix/issue-42)
#   $3 = absolute path to the assembled framework prompt
#   $4 = absolute path to the worktree (already created by `chi issue fix`)
#
# Responsibilities:
#   1. cd into the worktree the subcommand prepared.
#   2. Write a chi-flow marker into the per-worktree git dir so the user's
#      subsequent `chi ship` / `chi done` calls have the metadata they need
#      (branch, base, issue → "Closes #N" injection).
#   3. Hand the prompt to `claude` in interactive mode so the user can drive
#      the CTX → EXP → PRD lifecycle with AskUserQuestion decisions.
# Ship/merge stay manual: the user runs `chi ship` / `chi done` themselves
# from inside the worktree.

set -euo pipefail

NUM="${1:?issue number required}"
BRANCH="${2:?branch name required}"
PROMPT_FILE="${3:?prompt file path required}"
WORKTREE_PATH="${4:?worktree path required}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "issue-fix: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi
if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "issue-fix: worktree not found: $WORKTREE_PATH" >&2
  exit 1
fi

cd "$WORKTREE_PATH"

# Per-worktree GIT_DIR resolves to .git/worktrees/<name>/. The chi-flow marker
# lives there so chi ship / chi done can find it without colliding with any
# flow that might be active in the main worktree.
GIT_DIR=$(git rev-parse --git-dir)
cat > "$GIT_DIR/chi-flow" <<EOF
branch=$BRANCH
base=main
issue=$NUM
EOF

echo "── issue-fix: launching claude in worktree $WORKTREE_PATH ──"
echo "(prompt: $PROMPT_FILE)"
echo

# Pipe the prompt as the opening turn; claude continues interactively from there.
# `exec` is intentionally omitted so the chi parent regains control after claude
# exits — cmdFix then prints the manual ship+done next-steps.
claude < "$PROMPT_FILE"
