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

# Write the pre-commit hook — catches escaped backtick bugs before they're even committed
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/bin/bash
# GPS Portal pre-commit hook — blocks commits with escaped backtick (\\`) syntax errors
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

ERRORS=0
for f in coach.html client.html diagnostic-leader.html; do
  [ -f "$f" ] || continue
  COUNT=$(python3 -c "
with open('$f', 'r', encoding='utf-8') as fh:
    c = fh.read()
print(c.count(chr(92) + chr(96)))
" 2>/dev/null)
  if [ "$COUNT" -gt "0" ]; then
    echo "  ✗ pre-commit blocked: $f contains $COUNT escaped backtick(s) — JS syntax error"
    echo "    Search for \\\\\` in the file and replace with plain backtick inside template expressions."
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt "0" ]; then
  echo ""
  echo "  Commit blocked. Fix the escaped backtick(s) above before committing."
  exit 1
fi
exit 0
HOOK

chmod +x "$HOOKS_DIR/pre-push"
chmod +x "$HOOKS_DIR/pre-commit"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Git hooks installed."
echo ""
echo "  pre-commit: blocks escaped backtick bugs"
echo "  pre-push:   runs full check.sh validation"
echo "  Both hooks block if checks fail."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
