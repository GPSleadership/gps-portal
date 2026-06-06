---
name: gps-portal-safe-build
description: >
  Use whenever making ANY change to the GPS Leadership portal (the gps-portal repo:
  coach.html, client.html, decision-room.html, feedback.html, survey/diagnostic pages,
  api/*.js serverless functions, vercel.json, or Supabase migrations) — or to a similar
  single-repo web app deployed on Vercel with a Supabase backend. Enforces a
  branch → preview → seed/test → checks → migrate → merge workflow so production is
  never edited directly and the live portal is never broken. Trigger on: "change the
  portal", "add a feature to coach/client", "edit the Decision Room", "new portal
  endpoint", "fix the portal", "build X into the portal", or any edit to the portal
  files under the working folder.
---

# GPS Portal — Safe Build Workflow

**Golden rule: never edit `main` directly, and never push untested code to production.**
Every change goes onto a branch, gets a Vercel preview, is tested with seed data, passes
the checks, and only then merges to `main` (which auto-deploys to `portal.gpsleadership.org`).

The user runs all `git` commands on their Mac. You provide exact, single-line commands
(no backslash line-continuations; assume they are already in the repo directory).

## 1. Start on a branch — never on main
```
git checkout main
git pull origin main
git checkout -b <short-feature-name>
```
If the user is mid-feature, confirm which branch they're on (`git branch --show-current`)
before editing.

## 2. Build in small, verifiable increments
After each file edit, validate syntax before moving on:
- `api/*.js`: `node --check api/<file>.js`
- HTML pages: extract every `<script>` block and `node --check` the concatenation.
- Scan `coach.html` and `client.html` for escaped backticks (`\``) — baseline must be **0**.

## 3. Respect the security model (CRITICAL — post-v26 lockdown)
- The browser NEVER queries Supabase with the anon key. The anon key is dead for data.
- All reads/writes go through token/session-validated serverless endpoints that use
  `SUPABASE_SECRET_KEY` (service role, bypasses RLS):
  - Client-portal data → an action in `api/portal-data.js` (token-scoped to the client).
  - Coach-dashboard data → `api/coach-data.js` (generic op/table allowlist) or a dedicated action.
  - Sponsor (Decision Room) data → `api/sponsor-data.js` (the security boundary).
  - Diagnostic / generation / email → `api/diagnostic.js`.
- A new read/write means **add an endpoint action**, never a `db.from(...)` anon call.
- Confidentiality = OMIT data from the response server-side. Never hide it only in the UI,
  never rely on RLS as the gate. The endpoint is the access-control gate.
- Never expose `SUPABASE_SECRET_KEY` to the browser. Never add an anon RLS policy to "fix" a
  blocked read — route it through an endpoint instead.

## 4. Migrations are additive and applied BEFORE the merge
- Write `supabase-migration-vNN-*.sql`, additive only (old code ignores new columns/tables),
  with a `-- ROLLBACK` block at the bottom.
- New tables: `ENABLE ROW LEVEL SECURITY` + no anon policies (deny-all; service-role only),
  matching the rest of the schema.
- Apply to production Supabase and verify the columns/rows, then proceed. Old code keeps
  working because it never references the new columns.

## 5. Push the branch → test on the PREVIEW (not production)
```
git add <files>
git commit -m "<message>"
git push origin <branch>
```
Vercel builds a **preview** deployment. Test on it, not the live domain:
- The bare preview root 404s (no index page). **Append the page path**:
  `https://gps-portal-<hash>-…vercel.app/coach.html` (or `/decision-room?token=…`, `/client?token=…`).
- Always use the **newest** deployment for that branch (Vercel → Deployments → top entry).
  If the user "doesn't see" a change, they're usually on a stale preview URL.
- Confirm the deployment status is **Ready**, not **Error**. If Error, read the build log.

## 6. Test with clearly-labeled seed data
- Seed realistic test rows prefixed `TEST ` so they're trivially deletable. Cover the range
  (strong / mid / weak / mixed leaders; standard + private sponsors; one-person teams).
- Always provide a one-line cleanup script that deletes only `name like 'TEST %'` rows in
  FK-safe order (children before parents).
- Exercise the new flow AND a regression pass (login, a check-in, Ask Alex, a sponsor link).

## 7. Run the pre-push check
Run `check.sh`. It must pass: JS syntax, escaped-backtick baseline 0, `vercel.json` /
`.vercelignore` consistency, serverless function count, and no untracked portal files.
(`node` may not be installed on the user's Mac, so the syntax sub-checks can be skipped
there — rely on the sandbox `node --check` instead.)

## 8. Merge to production only when green
```
git checkout main
git merge <branch>
git push origin main
```
Smoke-test the real domain within a minute: `/coach` loads, a client portal loads and a
check-in submits, a sponsor link renders. Then delete the test rows.

## Rollback (if the smoke test fails)
```
git revert -m 1 HEAD
git push origin main
```
Production returns to the pre-change code immediately. Additive migrations can stay (the old
code never reads the new columns). Tell the user what broke; fix forward on a branch.

## Never do
- Edit `main` directly or push untested code to production.
- Use the anon key for data, or add an anon RLS policy to unblock a read.
- Expose the service key to the browser.
- Generate a deliverable (report, etc.) for a real client from un-reviewed AI output —
  drafts are coach-reviewed/approved before anyone external sees them.
