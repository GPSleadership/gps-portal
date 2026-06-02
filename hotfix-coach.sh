#!/bin/bash
# GPS Portal — Hotfix: revert coach.html to fix login
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

REPO_DIR=""
for candidate in \
  "$HOME/Documents/GitHub/gps-portal" \
  "$HOME/Documents/gps-portal" \
  "$HOME/Developer/gps-portal" \
  "$HOME/Projects/gps-portal" \
  "$HOME/gps-portal" \
  "$HOME/Desktop/gps-portal"
do
  if [ -d "$candidate/.git" ]; then REPO_DIR="$candidate"; break; fi
done

if [ -z "$REPO_DIR" ]; then echo -e "${RED}Repo not found.${NC}"; exit 1; fi

echo -e "${YELLOW}Reverting coach.html...${NC}"
cd "$REPO_DIR"
git checkout HEAD~1 -- coach.html
git add coach.html
git commit -m "hotfix: revert coach.html login fix — template literal syntax error"
git push origin HEAD
echo -e "${GREEN}Done. Vercel deploys in ~30 seconds. Reload coach.html.${NC}"
