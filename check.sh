#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GPS Portal — Pre-Push Validation
# Runs automatically via git pre-push hook. Also callable directly.
# Catches JS parse errors and vercel.json mismatches before they hit Vercel.
# ─────────────────────────────────────────────────────────────────────────────

# Make sure we're in the right directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Find node — git hooks run in a stripped shell, so try several strategies
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
NODE=$(command -v node 2>/dev/null)

# Strategy 2: zsh login shell (catches nvm/homebrew configured via .zshrc — most common on Mac)
if [ -z "$NODE" ]; then
  NODE=$(zsh -l -c 'command -v node 2>/dev/null' 2>/dev/null)
fi

# Strategy 3: bash login shell (catches nvm configured via .bash_profile)
if [ -z "$NODE" ]; then
  NODE=$(bash -l -c 'command -v node 2>/dev/null' 2>/dev/null)
fi

# Strategy 4: common nvm paths directly
if [ -z "$NODE" ]; then
  for NVM_NODE in "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$NVM_NODE" ]; then
      NODE="$NVM_NODE"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  echo "  ⚠  node not found — JS syntax check skipped"
  echo "     (Install Node.js from nodejs.org for full validation)"
  NODE="SKIP"
fi

ERRORS=0
WARNINGS=0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GPS Portal Pre-Push Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 0. Core files must exist (guards against a broken/empty "delete-everything" commit) ──
echo ""
echo "▸ Core files present"
CORE_FILES=("coach.html" "client.html" "diagnostic-survey.html" "survey.html" "vercel.json" "api/health.js" "api/coach-data.js" "api/diagnostic.js" "api/get-client.js")
MISSING=0
for f in "${CORE_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "  ✗ MISSING: $f — refusing to push. This looks like a broken/empty commit."
    ERRORS=$((ERRORS + 1)); MISSING=$((MISSING + 1))
  fi
done
if [ "$MISSING" -eq 0 ]; then
  echo "  ✓ All ${#CORE_FILES[@]} core files present"
fi

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

  if [ "$NODE" = "SKIP" ]; then
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

# ── 1b. Serverless function syntax (node --check on every api/*.js) ───────────
# Catches load-time errors in serverless functions (e.g. duplicate top-level
# declarations from a bad merge) that the HTML-only check above would miss.
# Each file is checked as a module (.mjs) so module-only early errors are caught.
echo ""
echo "▸ API function syntax (api/*.js)"
if [ "$NODE" = "SKIP" ]; then
  echo "  ⚠  skipped (node not found)"
  WARNINGS=$((WARNINGS + 1))
elif [ -d api ]; then
  API_OK=0
  for f in api/*.js; do
    [ -f "$f" ] || continue
    cp "$f" /tmp/gps_api_check.mjs 2>/dev/null
    RESULT=$("$NODE" --check /tmp/gps_api_check.mjs 2>&1)
    if [ $? -ne 0 ]; then
      CLEAN=$(echo "$RESULT" | sed 's|/tmp/gps_api_check.mjs|'"$f"'|g')
      echo "  ✗ $f"
      echo "    $CLEAN"
      ERRORS=$((ERRORS + 1))
    else
      API_OK=$((API_OK + 1))
    fi
  done
  echo "  ✓ $API_OK api/*.js file(s) parsed cleanly"
else
  echo "  ⚠  no api/ directory found"
  WARNINGS=$((WARNINGS + 1))
fi

# ── 2. Backslash-backtick scan (the bug that broke login) ─────────────────────
# Known-safe baseline: legitimate escaped backticks inside template literals.
# Only flag if the count EXCEEDS the baseline for that file.
echo ""
echo "▸ Known syntax hazards"

# bash 3.2 compatible (macOS default has no associative arrays). Baseline is 0 for both.
HAZARD_FOUND=0

for f in coach.html client.html; do
  if [ ! -f "$f" ]; then
    continue
  fi
  COUNT=$(python3 -c "
with open('$f', 'r', encoding='utf-8') as fh:
    content = fh.read()
print(content.count(chr(92) + chr(96)))
" 2>/dev/null)

  if [ "${COUNT:-0}" -gt "0" ]; then
    echo "  ✗ $f: ${COUNT} escaped backtick(s) found — likely JS syntax error"
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
echo "▸ Serverless function count (Vercel Pro — no hard limit)"

python3 - <<'PYEOF'
import os, sys

all_funcs = [f for f in os.listdir('api') if f.endswith('.js')] if os.path.isdir('api') else []

ignored = set()
if os.path.exists('.vercelignore'):
    with open('.vercelignore', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                ignored.add(os.path.basename(line))

deployed = sorted([f for f in all_funcs if f not in ignored])
count = len(deployed)

print(f"  ✓ {count} functions deployed: {', '.join(deployed)}")
PYEOF

FUNC_EXIT=$?
if [ $FUNC_EXIT -ne 0 ]; then
  ERRORS=$((ERRORS + 1))
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

# ── 6. Deploy exposure guard (prevents public-by-default files) ────────────────
# Root cause of the 2026-07 console + zip-blob exposures: the deploy is a denylist,
# so any new tracked file is public by default. This blocks a push when a file that
# WOULD deploy is (a) extensionless (blob), (b) an HTML page not on the allowlist,
# or (c) contains a hardcoded API secret (re_/sk-ant-/sk-). Anon/publishable keys are
# intentionally NOT flagged (they're safe to be public).
echo ""
echo "▸ Deploy exposure guard"
python3 - <<'PYEOF'
import subprocess, os, re, fnmatch, sys
errs = []
tracked = subprocess.check_output(['git','ls-files']).decode().splitlines()
pats = []
if os.path.exists('.vercelignore'):
    for l in open('.vercelignore'):
        l = l.strip()
        if l and not l.startswith('#'): pats.append(l)
def ignored(f):
    for p in pats:
        pp = p.rstrip('/')
        if fnmatch.fnmatch(f, p) or fnmatch.fnmatch(os.path.basename(f), p) or f == pp or f.startswith(pp + '/'):
            return True
    return False
deployed = [f for f in tracked if not ignored(f)]
# a) extensionless files (the zip-blob class)
for f in deployed:
    if '.' not in os.path.basename(f):
        errs.append(f"extensionless file would deploy publicly: {f}  → add to .vercelignore or delete")
# b) HTML pages not on the allowlist (the finance-console class)
allow = set()
if os.path.exists('deploy-allowed-pages.txt'):
    for l in open('deploy-allowed-pages.txt'):
        l = l.strip()
        if l and not l.startswith('#'): allow.add(l)
for f in deployed:
    if f.lower().endswith('.html') and f not in allow:
        errs.append(f"HTML would deploy publicly but isn't in deploy-allowed-pages.txt: {f}  → add it there if it's meant to be public, else .vercelignore it")
# c) hardcoded API secrets in the deploy set (NOT anon/publishable keys)
secret = re.compile(r'(re_[A-Za-z0-9]{18,}|sk-ant-[A-Za-z0-9\-]{18,}|sk-[A-Za-z0-9]{24,})')
for f in deployed:
    try:
        if os.path.getsize(f) > 2_000_000: continue
        m = secret.search(open(f, encoding='utf-8', errors='ignore').read())
        if m: errs.append(f"possible hardcoded API secret in deployed file {f}: '{m.group(0)[:8]}…'  → move to an env var")
    except Exception:
        pass
if errs:
    for e in errs: print("  ✗ " + e)
    sys.exit(1)
print("  ✓ No extensionless blobs, unlisted pages, or hardcoded secrets in the deploy set")
PYEOF
if [ $? -ne 0 ]; then
  ERRORS=$((ERRORS + 1))
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
