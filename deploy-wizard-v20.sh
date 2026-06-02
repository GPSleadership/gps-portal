#!/bin/bash
# GPS Leadership Portal — Wizard v20 Deployment Script
# Usage: bash "/Users/alex.tremble/Documents/Claude/Projects/Tool Creation/deploy-wizard-v20.sh"

set -e  # Stop immediately if any command fails

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

TOOL_DIR="/Users/alex.tremble/Documents/Claude/Projects/Tool Creation"
REPO_URL="https://github.com/GPSleadership/gps-portal.git"
SUPABASE_SQL_URL="https://supabase.com/dashboard/project/pbnkefuqpoztcxfagiod/sql/new"

clear
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   GPS Portal — Onboarding Wizard v20 Deploy         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── STEP 1: Migration check ─────────────────────────────────────────────────
echo -e "${YELLOW}[1/5] Supabase Migration${NC}"
echo ""
echo "Before the code deploys, migration v20 must run in Supabase first."
echo "It adds three new columns — takes about 10 seconds."
echo ""
echo "  1. Open this URL in your browser:"
echo -e "     ${BOLD}${SUPABASE_SQL_URL}${NC}"
echo ""
echo "  2. Paste the SQL from:"
echo -e "     ${BOLD}${TOOL_DIR}/supabase-migration-v20.sql${NC}"
echo ""
echo "  3. Click Run. You should see 3 rows in the results."
echo ""

# Auto-open Supabase SQL editor
open "$SUPABASE_SQL_URL" 2>/dev/null || true

read -p "  Type Y once the migration is confirmed in Supabase: " migrated
if [[ ! "$migrated" =~ ^[Yy]$ ]]; then
  echo -e "\n${RED}Deploy cancelled. Run the migration first, then re-run this script.${NC}\n"
  exit 1
fi
echo -e "${GREEN}  ✓ Migration confirmed${NC}\n"

# ─── STEP 2: Locate or clone the repo ────────────────────────────────────────
echo -e "${YELLOW}[2/5] Locating GPS Portal repository...${NC}"

REPO_DIR=""
for candidate in \
  "$HOME/Documents/GitHub/gps-portal" \
  "$HOME/Documents/gps-portal" \
  "$HOME/Developer/gps-portal" \
  "$HOME/Projects/gps-portal" \
  "$HOME/gps-portal" \
  "$HOME/Desktop/gps-portal"
do
  if [ -d "$candidate/.git" ]; then
    REPO_DIR="$candidate"
    echo -e "${GREEN}  ✓ Found at: $REPO_DIR${NC}\n"
    break
  fi
done

if [ -z "$REPO_DIR" ]; then
  echo "  Repo not found locally. Cloning from GitHub..."
  REPO_DIR="$HOME/Documents/gps-portal"
  git clone "$REPO_URL" "$REPO_DIR"
  echo -e "${GREEN}  ✓ Cloned to: $REPO_DIR${NC}\n"
fi

# ─── STEP 3: Pull latest from GitHub ─────────────────────────────────────────
echo -e "${YELLOW}[3/5] Pulling latest from GitHub...${NC}"
cd "$REPO_DIR"
git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || echo "  (already up to date)"
echo -e "${GREEN}  ✓ Repo is current${NC}\n"

# ─── STEP 4: Copy updated files ──────────────────────────────────────────────
echo -e "${YELLOW}[4/5] Copying updated files into repo...${NC}"

cp "$TOOL_DIR/client.html"                "$REPO_DIR/client.html"                && echo "  ✓ client.html"
cp "$TOOL_DIR/coach.html"                 "$REPO_DIR/coach.html"                 && echo "  ✓ coach.html"
cp "$TOOL_DIR/get-client.js"              "$REPO_DIR/api/get-client.js"          && echo "  ✓ api/get-client.js"
cp "$TOOL_DIR/notify.js"                  "$REPO_DIR/api/notify.js"              && echo "  ✓ api/notify.js"
cp "$TOOL_DIR/supabase-migration-v20.sql" "$REPO_DIR/supabase-migration-v20.sql" && echo "  ✓ supabase-migration-v20.sql (reference)"
echo ""

# ─── STEP 5: Commit and push ─────────────────────────────────────────────────
echo -e "${YELLOW}[5/5] Committing and pushing to GitHub...${NC}"
cd "$REPO_DIR"

git add client.html coach.html api/get-client.js api/notify.js supabase-migration-v20.sql

if git diff --cached --quiet; then
  echo -e "${YELLOW}  No changes detected — files may already match the repo.${NC}"
else
  git commit -m "feat: onboarding wizard v20

- Replace FormB with 8-step wizard (initWizard)
- Diagnostic prefill from get-client.js diagnostic_prefill field
- New Metric 2: stakeholder perception question + 1-5 scale
- Stakeholder step with deduplication on lock-in
- Required rewards (30-day and 90-day)
- Back-nav preserves form state
- Existing client plans unaffected (backward compat)
- get-client.js: diagnostic prefill lookup added
- notify.js: plan_submitted includes Metric 2, Behavior 2, 30-Day Goal
- coach.html: dual Metric 2 display (new vs legacy model)
- supabase-migration-v20.sql: adds metric_2_question, metric_2_target_avg, wizard_prefill_data"

  git push origin HEAD
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║   ✅ Pushed to GitHub. Vercel is deploying now.      ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}Vercel deploys in ~30 seconds. Then smoke test:${NC}"
echo "  1. Open a client portal link for a client without a plan"
echo "  2. Confirm Step 0 Welcome screen loads (not the old scroll form)"
echo "  3. Walk all 8 steps and lock in a test plan"
echo "  4. Check alex@gpsleadership.org for the plan notification email"
echo "  5. Open /coach and verify the plan shows the new Metric 2 format"
echo ""
echo -e "${BOLD}Rollback command (if anything breaks):${NC}"
echo ""
echo "  cp \"$TOOL_DIR/client-PRE-WIZARD-BACKUP-2026-06-01.html\" \\"
echo "     \"$REPO_DIR/client.html\" && \\"
echo "     cd \"$REPO_DIR\" && \\"
echo "     git add client.html && \\"
echo "     git commit -m 'rollback: revert client.html to pre-wizard' && \\"
echo "     git push origin HEAD"
echo ""
