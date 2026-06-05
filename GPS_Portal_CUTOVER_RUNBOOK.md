# GPS Portal — Phase 1 Security Cutover Runbook

**Goal:** Take the `security-hardening-phase1` branch live and lock down the database, with no outage window.
**Time needed:** ~15–20 minutes. Pick a low-traffic window (no client mid-check-in, no open diagnostic survey, not during a coaching call).
**Who does what:** Steps marked **[You]** need your Vercel/GitHub login. Steps marked **[Claude]** I can run through the Supabase connection if you want.

---

## Why the order matters (read once)

There is **one** database shared by everything. The `v26` migration locks it so only the service key works. If you lock the DB while the *old* anon code is still serving production, production breaks. So the rule is: **get the new code live first, then lock the DB.** Done in the order below, every step works against a working system — there is no moment where the live portal is broken.

The legacy coach password keeps working right through the cutover (the login endpoint reads it with the service key, which bypasses the lock), so you are never locked out. You set the new hashed password at the end, at your leisure.

---

## Pre-flight checklist

- [ ] You're in a low-traffic window.
- [ ] You have a generated session secret ready. Run: `openssl rand -hex 32` and copy the output.
- [ ] You know your current coach password (you'll log in with it once, mid-cutover).
- [ ] The branch is committed and clean: `git status` shows nothing uncommitted on `security-hardening-phase1`.

---

## Step 1 — Push the branch (creates a safe preview) **[You]**

```
cd ~/Documents/Claude/Projects/Tool\ Creation
git push origin security-hardening-phase1
```

Vercel builds a **preview** deployment from this branch. This does **not** touch `portal.gpsleadership.org`. Find the preview URL in the Vercel dashboard (Deployments → the `security-hardening-phase1` one → Visit).

## Step 2 — Set the session secret in Vercel **[You]**

Vercel → Project → Settings → Environment Variables → Add:
- **Name:** `COACH_SESSION_SECRET`
- **Value:** the `openssl rand -hex 32` output from pre-flight
- **Environments:** check **Production** AND **Preview**

Then **redeploy the preview** so it picks up the variable (Deployments → preview → ⋯ → Redeploy).

## Step 3 — Smoke-test the PREVIEW url **[You]**

On the preview URL, confirm (the DB is still open here, so this only tests the new code):
- [ ] `/coach` — log in with your current password. Dashboard loads, clients show.
- [ ] `/coach-emergency` — log in. Client list loads.
- [ ] A client portal `/client?token=…` — loads, a check-in submits, Ask Alex answers.
- [ ] `/diagnostic-leader?token=…` (if you have a live one) — loads.
- [ ] A diagnostic survey `/diagnostic-survey?token=…` — loads.

If anything fails here, **stop** — fix on the branch before going further. Nothing is live yet.

## Step 4 — Promote to production **[You]**

```
cd ~/Documents/Claude/Projects/Tool\ Creation
git checkout main
git merge security-hardening-phase1
git push origin main
```

Vercel deploys the new code to `portal.gpsleadership.org`. The DB is still open, so the live portal keeps working exactly as before — just on the new code now. Quickly confirm `/coach` on the **real** domain still logs in.

## Step 5 — Lock the database (the actual security fix) **[Claude or You]**

Apply `supabase-migration-v26-lockdown-rls.sql`.
- **[Claude]** I run it through the Supabase connection and confirm.
- **[You]** Supabase → SQL Editor → paste the file's contents (the part above the `ROLLBACK` block) → Run.

The moment this finishes, the anon key can no longer touch any table. Production keeps working because it now runs on the service-key endpoints.

## Step 6 — Quick production re-test **[You]**

On the **real** domain, within a minute of Step 5:
- [ ] `/coach` still loads clients (confirms coach-data works under the lock).
- [ ] A client portal loads and a check-in submits.
- [ ] Ask Alex answers.

If any of these fail → go to **Rollback** below.

## Step 7 — Set your new password **[You]**

- Go to `/coach-emergency` → "Reset password" → "Email me a reset code".
- Check alex@gpsleadership.org for the code, enter it with a new strong password (min 8 chars, not `GPS2026`).
- Log out and back in with the new password to confirm.

## Step 8 — Verify it's actually closed **[Claude]**

I re-run the Supabase **security advisor** and confirm:
- [ ] Zero `rls_policy_always_true` warnings.
- [ ] Zero public-bucket-listing warnings.
- [ ] The anon-executable SECURITY DEFINER function warnings are gone.

Done. The portal is hardened, and `main` is now the secure base for your new feature.

---

## Rollback (only if Step 6 fails)

The lock is reversible in seconds:

1. **Reopen the DB:** run the `ROLLBACK` block at the bottom of `supabase-migration-v26-lockdown-rls.sql` (recreates the permissive policies). The portal returns to its pre-cutover behavior immediately.
2. **If the new code itself is the problem:** revert the merge and redeploy:
   ```
   git revert -m 1 HEAD
   git push origin main
   ```
3. Tell me what broke; we fix on the branch and re-run the cutover later. Nothing is lost — every increment is committed.

---

## Deliberately NOT in this cutover (safe to defer)

- **Step 5 of the plan — full report-bucket privatization.** The bucket is already non-listable; report URLs are unguessable UUIDs and the diagnostics table is now locked, so the table-read path to them is closed. Full signed-URL serving is defense-in-depth, separate change.
- **Step 7 of the plan — `ghl_export_view` → SECURITY INVOKER.** Deferred until we confirm what consumes that view (likely a GHL/Make export), so we don't break an export. The risky RPC `EXECUTE` grants are already revoked in `v26`.

Both can be done in a later quiet window. Neither blocks you building your new feature on secure `main`.

---

## After cutover: building your new feature

Once `main` is secure, build the new feature using the established pattern — never `db.from(...)` with the anon key:
- Client-portal data → add an action to `api/portal-data.js` (token-scoped to the client).
- Coach-dashboard data → use `api/coach-data.js` (generic `op`/`table`, or a dedicated action for sensitive bits).
- Diagnostic pages → add an action to `api/diag-portal.js`.

Tell me what the feature does and I'll wire its data layer through the right endpoint.
