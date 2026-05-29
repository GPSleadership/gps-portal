#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GPS Portal — Post-Deploy Smoke Test
# Run this ~90 seconds after a push to confirm the live portal is healthy.
# Checks that pages load, expected content is present, and APIs respond.
#
# Usage: ./smoke-test.sh
# ─────────────────────────────────────────────────────────────────────────────

BASE="https://portal.gpsleadership.org"
ERRORS=0
WARNINGS=0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GPS Portal Smoke Test"
echo "  $BASE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Helper: fetch URL, return HTTP status code
http_status() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$1"
}

# Helper: fetch URL body
http_body() {
  curl -s --max-time 15 "$1"
}

# ── 1. Coach portal ───────────────────────────────────────────────────────────
echo ""
echo "▸ Coach portal (/coach)"

STATUS=$(http_status "$BASE/coach")
if [ "$STATUS" = "200" ]; then
  echo "  ✓ HTTP $STATUS"
else
  echo "  ✗ HTTP $STATUS — expected 200"
  ERRORS=$((ERRORS + 1))
fi

# Check for known content that confirms it's the GPS coach portal
BODY=$(http_body "$BASE/coach")
if echo "$BODY" | grep -q "Coach Access"; then
  echo "  ✓ Login screen present"
else
  echo "  ✗ Login screen not found in response — wrong page or stale cache"
  ERRORS=$((ERRORS + 1))
fi

if echo "$BODY" | grep -q "checkPassword"; then
  echo "  ✓ JavaScript loaded (checkPassword function present)"
else
  echo "  ✗ checkPassword not found — script block may be missing or broken"
  ERRORS=$((ERRORS + 1))
fi

# Check that the broken \` pattern is NOT in the live page
if echo "$BODY" | python3 -c "
import sys
content = sys.stdin.read()
count = content.count(chr(92) + chr(96))
if count > 0:
    print(f'  ✗ Live page contains {count} escaped backtick(s) — JS parse error in production')
    sys.exit(1)
else:
    print('  ✓ No escaped backtick hazards in live page')
" 2>/dev/null; then
  true
else
  ERRORS=$((ERRORS + 1))
fi

# ── 2. Client portal ──────────────────────────────────────────────────────────
echo ""
echo "▸ Client portal (/client)"

STATUS=$(http_status "$BASE/client")
if [ "$STATUS" = "200" ]; then
  echo "  ✓ HTTP $STATUS"
else
  echo "  ✗ HTTP $STATUS — expected 200"
  ERRORS=$((ERRORS + 1))
fi

BODY=$(http_body "$BASE/client")
if echo "$BODY" | grep -q "GPS Leadership"; then
  echo "  ✓ GPS Leadership branding present"
else
  echo "  ✗ GPS Leadership branding not found — wrong page served"
  ERRORS=$((ERRORS + 1))
fi

# ── 3. API — get-client (expects 400/401 without token, not 500) ──────────────
echo ""
echo "▸ API health (/api/get-client)"

STATUS=$(http_status "$BASE/api/get-client")
if [ "$STATUS" = "400" ] || [ "$STATUS" = "401" ] || [ "$STATUS" = "405" ]; then
  echo "  ✓ HTTP $STATUS — API responding (no token = expected rejection)"
elif [ "$STATUS" = "200" ]; then
  echo "  ✓ HTTP $STATUS"
elif [ "$STATUS" = "500" ]; then
  echo "  ✗ HTTP 500 — API is crashing (server error)"
  ERRORS=$((ERRORS + 1))
else
  echo "  ⚠  HTTP $STATUS — unexpected response"
  WARNINGS=$((WARNINGS + 1))
fi

# ── 4. API — diagnostic (expects 400 without action, not 500) ─────────────────
echo ""
echo "▸ API health (/api/diagnostic)"

STATUS=$(http_status "$BASE/api/diagnostic")
if [ "$STATUS" = "400" ] || [ "$STATUS" = "401" ] || [ "$STATUS" = "405" ]; then
  echo "  ✓ HTTP $STATUS — API responding"
elif [ "$STATUS" = "500" ]; then
  echo "  ✗ HTTP 500 — diagnostic API is crashing"
  ERRORS=$((ERRORS + 1))
else
  echo "  ⚠  HTTP $STATUS"
  WARNINGS=$((WARNINGS + 1))
fi

# ── 5. Supabase CDN (script loads correctly) ──────────────────────────────────
echo ""
echo "▸ Supabase JS library"

STATUS=$(http_status "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2")
if [ "$STATUS" = "200" ]; then
  echo "  ✓ CDN reachable"
else
  echo "  ⚠  CDN returned $STATUS — Supabase JS may not load for clients"
  WARNINGS=$((WARNINGS + 1))
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $ERRORS -gt 0 ]; then
  echo "  PORTAL ISSUE — $ERRORS check(s) failed."
  echo "  Review errors above. If it just deployed,"
  echo "  wait 30 more seconds and re-run."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo "  PORTAL UP — $WARNINGS warning(s). Review above."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
else
  echo "  PORTAL HEALTHY — all checks passed."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
fi
