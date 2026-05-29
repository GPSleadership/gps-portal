#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GPS Portal — Install Git Hooks
# One-time setup. After running this, every "git push" automatically
# runs check.sh. Blocked if checks fail. No extra steps required.
#
# Usage: ./install-hooks.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo ""
  echo "  ✗ .git/hooks directory not found."
  echo "    Make sure you're running this from the gps-portal repo root."
  echo ""
  exit 1
fi

# Write the pre-push hook
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/bin/bash
# GPS Portal pre-push hook — runs check.sh automatically on every git push
REPO_ROOT="$(git rev-parse --show-toplevel)"
CHECK_SCRIPT="$REPO_ROOT/check.sh"

if [ ! -f "$CHECK_SCRIPT" ]; then
  echo "  ⚠  check.sh not found — skipping pre-push validation"
  exit 0
fi

bash "$CHECK_SCRIPT"
exit $?
HOOK

chmod +x "$HOOKS_DIR/pre-push"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Git hooks installed."
echo ""
echo "  Every 'git push' now runs check.sh"
echo "  automatically. Push blocked if checks"
echo "  fail. Nothing else changes."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
