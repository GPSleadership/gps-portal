#!/usr/bin/env zsh
cd "/Users/alex.tremble/Documents/Claude/Projects/Tool Creation"
echo "=== GPS Portal — Deploy Login Fix ==="
rm -f .git/index.lock
git add coach.html
git commit -m "Fix: remove invalid escaped backtick in IIFE — was breaking JS parse and blocking portal login"
echo ""
echo "Pushing to GitHub..."
git push origin main
echo ""
echo "Done. Check portal.gpsleadership.org/coach in ~30 seconds."
echo ""
