#!/usr/bin/env zsh
REPO="/Users/alex.tremble/Documents/Claude/Projects/Tool Creation"
cd "$REPO"

echo ""
echo "=== GPS Portal — Push to GitHub ==="
echo ""

# Show what git sees right now
echo "Git status:"
git status --short
echo ""

# Force-stage coach.html and commit if there are changes
git add -f coach.html
if git diff --cached --quiet; then
  echo "Nothing new to commit — coach.html already matches git index."
  echo "Trying push anyway in case there are unpushed commits..."
else
  echo "Changes staged:"
  git diff --cached --stat
  echo ""
  git commit -m "Portal update: PDF upload + offline survey import"
fi

echo ""
echo "Pushing to GitHub..."
git push origin main

echo ""
echo "Done. Check Vercel in ~30 seconds:"
echo "https://portal.gpsleadership.org/coach"
echo ""
