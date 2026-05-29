#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GPS Portal — Pre-Push Validation
# Runs automatically via git pre-push hook. Also callable directly.
# Catches JS parse errors and vercel.json mismatches before they hit Vercel.
# ─────────────────────────────────────────────────────────────────────────────

# Make sure we're in the right directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Find node — check common Mac install locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH"
NODE=$(command -v node 2>/dev/null)
if [ -z "$NODE" ]; then
  echo "  ⚠  node not found — skipping JS syntax check"
  echo "     Install Node.js from nodejs.org if you want full validation"
  NODE="echo SKIP"
fi

ERRORS=0
WARNINGS=0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GPS Portal Pre-Push Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. JS syntax check on all HTML files ──────────────────────────────────────
echo ""
echo "▸ JavaScript syntax"

HTML_FILES=("coach.html" "client.html" "diagnostic-leader.html" "diagnostic-survey.html" "survey.html")

for f in "${HTML_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi

  # Extract all inline <script> blocks (no src attribute) and write to temp file
  python3 - "$f" <<'PYEOF' > /tmp/gps_check_js.js 2>/dev/null
import re, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    content = fh.read()
scripts = re.findall(r'<script(?![^>]*\bsrc\b)[^>]*>(.*?)</script>', content, re.DOTALL)
print('\n'.join(scripts))
PYEOF

  if [ "$NODE" = "echo SKIP" ]; then
    echo "  ⚠  $f — skipped (node not found)"
    WARNINGS=$((WARNINGS + 1))
    continue
  fi

  RESULT=$("$NODE" --check /tmp/gps_check_js.js 2>&1)
  if [ $? -ne 0 ]; then
    # Trim the temp file path from node's error message for readability
    CLEAN=$(echo "$RESULT" | sed 's|/tmp/gps_check_js.js|'"$f"'|g')
    echo "  ✗ $f"
    echo "    $CLEAN"
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✓ $f"
  fi
done

# ── 2. Backslash-backtick scan (the bug that broke login) ─────────────────────
echo ""
echo "▸ Known syntax hazards"

HAZARD_FILES=("coach.html" "client.html")
HAZARD_FOUND=0

for f in "${HAZARD_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  COUNT=$(python3 -c "
with open('$f', 'r', encoding='utf-8') as fh:
    content = fh.read()
print(content.count(chr(92) + chr(96)))
" 2>/dev/null)

  if [ "$COUNT" -gt "0" ]; then
    echo "  ✗ $f: $COUNT escaped backtick(s) found — likely JS syntax error"
    echo "    Search for \\\\\` in the file to locate them"
    ERRORS=$((ERRORS + 1))
    HAZARD_FOUND=1
  fi
done

if [ "$HAZARD_FOUND" -eq 0 ]; then
  echo "  ✓ No escaped backtick hazards"
fi

# ── 3. vercel.json vs .vercelignore consistency ────────────────────────────────
echo ""
echo "▸ vercel.json / .vercelignore consistency"

python3 - <<'PYEOF'
import json, os, sys

errors = []

# Read vercel.json
try:
    with open('vercel.json', 'r') as f:
        vj = json.load(f)
except Exception as e:
    print(f"  ✗ Could not read vercel.json: {e}")
    sys.exit(1)

# Read .vercelignore
ignored = set()
if os.path.exists('.vercelignore'):
    with open('.vercelignore', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                ignored.add(line)

# Check each function entry
functions = vj.get('functions', {})
for fn_path in functions:
    if fn_path in ignored:
        errors.append(f"  ✗ {fn_path}: listed in vercel.json functions BUT excluded by .vercelignore")
    if not os.path.exists(fn_path):
        errors.append(f"  ✗ {fn_path}: listed in vercel.json functions BUT file does not exist on disk")

if errors:
    for e in errors:
        print(e)
    sys.exit(1)
else:
    print("  ✓ vercel.json and .vercelignore are consistent")
PYEOF

if [ $? -ne 0 ]; then
  ERRORS=$((ERRORS + 1))
fi

# ── 4. Serverless function count ───────────────────────────────────────────────
echo ""
echo "▸ Serverless function count (Hobby plan limit: 12)"

python3 - <<'PYEOF'
import os, sys

# Count api/*.js files
all_funcs = [f for f in os.listdir('api') if f.endswith('.js')] if os.path.isdir('api') else []

# Read .vercelignore to find excluded ones
ignored = set()
if os.path.exists('.vercelignore'):
    with open('.vercelignore', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                # Normalize: "api/foo.js" -> "foo.js"
                ignored.add(os.path.basename(line))

deployed = [f for f in all_funcs if f not in ignored]
count = len(deployed)
limit = 12

if count > limit:
    print(f"  ✗ {count}/{limit} functions — OVER Hobby plan limit. Deployment will fail.")
    print(f"    Deployed: {', '.join(sorted(deployed))}")
    sys.exit(1)
elif count >= 11:
    print(f"  ⚠  {count}/{limit} functions — approaching Hobby plan limit")
    print(f"    One more api/*.js file will hit the cap")
else:
    print(f"  ✓ {count}/{limit} functions deployed")
PYEOF

FUNC_EXIT=$?
if [ $FUNC_EXIT -eq 1 ]; then
  ERRORS=$((ERRORS + 1))
elif [ $FUNC_EXIT -eq 2 ]; then
  WARNINGS=$((WARNINGS + 1))
fi

# ── 5. Check for uncommitted files that should be committed ───────────────────
echo ""
echo "▸ Git status"

UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(html|js|json|sh)$' | head -5)
if [ -n "$UNTRACKED" ]; then
  echo "  ⚠  Untracked files not staged for commit:"
  echo "$UNTRACKED" | while read line; do echo "    $line"; done
  WARNINGS=$((WARNINGS + 1))
else
  echo "  ✓ No untracked portal files"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $ERRORS -gt 0 ]; then
  echo "  FAILED — $ERRORS error(s). Fix before pushing."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo "  PASSED — $WARNINGS warning(s). Review above, then push."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
else
  echo "  ALL CLEAR — safe to push."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
fi
