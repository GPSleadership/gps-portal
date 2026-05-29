#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GPS Portal — Safe Deploy
# Runs all pre-push checks, then commits and pushes if everything passes.
# This replaces bare "git push origin main".
#
# Usage:
#   ./deploy.sh "your commit message"
#
# Examples:
#   ./deploy.sh "Add client intake notes field"
#   ./deploy.sh "Fix rater email correction bug"
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Require a commit message ──────────────────────────────────────────────────
if [ -z "$1" ]; then
  echo ""
  echo "  Usage: ./deploy.sh \"your commit message\""
  echo ""
  exit 1
fi

COMMIT_MSG="$1"

# ── Check for uncommitted changes ─────────────────────────────────────────────
STAGED=$(git diff --cached --name-only 2>/dev/null)
UNSTAGED=$(git diff --name-only 2>/dev/null)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(html|js|json|sh)$')

if [ -z "$STAGED" ] && [ -z "$UNSTAGED" ] && [ -z "$UNTRACKED" ]; then
  echo ""
  echo "  Nothing to commit — working tree is clean."
  echo "  If you want to force a push, use: git push origin main"
  echo ""
  exit 0
fi

# ── Run pre-push checks ───────────────────────────────────────────────────────
bash "$SCRIPT_DIR/check.sh"
CHECK_EXIT=$?

if [ $CHECK_EXIT -ne 0 ]; then
  echo "  Push cancelled. Fix the errors above first."
  echo ""
  exit 1
fi

# ── Stage, commit, push ───────────────────────────────────────────────────────
echo "▸ Staging all changes..."
git add -A

echo "▸ Committing: \"$COMMIT_MSG\""
git commit -m "$COMMIT_MSG"

COMMIT_EXIT=$?
if [ $COMMIT_EXIT -ne 0 ]; then
  echo ""
  echo "  Commit failed. Check git output above."
  exit 1
fi

echo "▸ Pushing to GitHub..."
git push origin main

PUSH_EXIT=$?
if [ $PUSH_EXIT -ne 0 ]; then
  echo ""
  echo "  Push failed. Check git output above."
  echo "  Your commit is saved locally — run 'git push origin main' to retry."
  exit 1
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pushed. Vercel deploys in ~60 seconds."
echo ""
echo "  Run ./smoke-test.sh in 90 seconds to"
echo "  confirm the live portal is healthy."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
