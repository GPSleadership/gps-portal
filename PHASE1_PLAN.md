# Phase 1 — Security Hardening (branch: `security-hardening-phase1`)

**Goal:** Close the live data-exposure findings from the June 3 premortem without taking the portal down.
**Branch:** `security-hardening-phase1` — nothing here deploys to production until Alex reviews and merges to `main`.
**Hard constraints baked into this plan:**
- ~~Vercel 12-function cap~~ — **No longer applies (on Vercel Pro as of June 2026).** New server logic *may* be a standalone `api/*.js` file now. The coach-auth code in this branch was folded into `get-client.js` while the cap still applied; it works fine as-is, but future endpoints (signed-URL report server, etc.) can be their own files for cleaner separation.
- **No `package.json` / no npm.** Serverless functions use Node built-ins only. Password hashing uses `crypto.scryptSync`; session tokens use `crypto.createHmac`. No bcrypt.

---

## The core idea

Today the browser holds the public `anon` key and talks to Supabase directly, and every table has an `anon USING(true)` policy — so the browser can read/write everything. The fix is to make the **service key the only key that can touch sensitive tables**, and route every browser read/write through a serverless function that checks a token (clients) or a session (coach). The `service_role` key bypasses RLS, so once the permissive `anon` policies are dropped, the API functions keep working and the browser loses its direct backdoor.

This is why the database change and the app change must ship **together**. Dropping the policies before the app is rewired breaks the live portal; rewiring the app before dropping the policies leaves the hole open. The sequence below keeps the portal working at every step.

---

## Build order (each step is independently testable on the preview deploy)

### Step 1 — Switch the two anon-keyed server functions to the service key  *(behavior-neutral, safe now)*
`diagnostic.js` and `send-reminders.js` currently call Supabase with `SUPABASE_ANON`. They run server-side and should use `SUPABASE_SECRET_KEY` like the other ten functions. This changes nothing visible today (service key works under the current permissive policies too) but is required before the lockdown. **Risk: low.** One-line change to each `sb()` helper.

### Step 2 — Add hardened coach auth (done in this branch, increment 1)
New `?action=coach-login` and `?action=coach-session` routes inside `get-client.js` (service key, already present — keeps us at 12 functions):
- `coach-login`: takes a password, verifies it against a **scrypt hash** stored in `coach_settings.coach_password_hash`, returns a signed, expiring HMAC session token. No plaintext anywhere.
- `coach-session`: verifies a session token (for page-load gating).
- Requires two new env vars: `COACH_SESSION_SECRET` (HMAC signing key) and a one-time step to write the scrypt hash. A helper to generate the hash is documented at the bottom of this file.

### Step 3 — Rewire `coach.html` login + reads
- Replace the client-side `coach_settings` password read in `checkPassword()` with a `fetch('/api/get-client?action=coach-login')` call; store the returned session token.
- Replace direct `db.from(...)` reads/writes in the coach dashboard with calls to service-key endpoints (add `?action=` routes to existing functions as needed). This is the largest single page.

### Step 4 — Rewire `client.html`, `diagnostic-leader.html`, `diagnostic-survey.html`
- These read/write `clients`, `diagnostics`, `diagnostic_raters`, `diagnostic_responses` directly with the anon key. Route each through token-validated service-key endpoints (extend `get-client.js` / `survey.js` / `diagnostic.js` with actions).
- The client portal already gets its record via `get-client.js` — extend that pattern to the remaining reads/writes (check-ins, survey submission, rater responses).

### Step 5 — Make the report bucket fully private  *(builds on the listing fix already shipped)*
- Flip `diagnostic-reports` bucket to private; serve PDFs via a token-validated endpoint returning a short-lived signed URL; move the coach upload from anon INSERT/UPDATE to the authenticated coach endpoint. Update `diagnostic-leader.html` to use the signed-URL endpoint instead of the public URL.

### Step 6 — Lock `/api/ask` + remove cron bypass  *(small, high-value)*
- `ask.js`: require a valid client `token` (verify against `clients`), enforce the daily cap in Postgres, restrict CORS to the portal origin.
- `send-reminders.js`, `survey-reminders.js`, `diagnostic.js?action=reminders`: remove the `manual_trigger:true` shortcut; require `Authorization: Bearer ${CRON_SECRET}`.

### Step 7 — Harden the extras the advisor flagged
- `ghl_export_view`: recreate as `SECURITY INVOKER` (or revoke anon/authenticated access).
- `get_survey_scoreboard`, `increment_ask_alex`: `REVOKE EXECUTE ... FROM anon, authenticated` (called server-side only) and set an explicit `search_path`.
- `gps_notes`, `gps_coach_uploads`, `gps_settings`: confirm intended use, then lock to service key.

### Step 8 — Cutover  *(needs Alex: pick a low-traffic window)*
1. Deploy the rewired app to production.
2. Apply `supabase-migration-v26-lockdown-rls.sql` (drops every permissive anon policy).
3. Set the new coach password hash + `COACH_SESSION_SECRET` env var.
4. Run the smoke test + re-run the Supabase security advisor — confirm the `rls_policy_always_true` warnings are gone.

---

## Test checklist (run on the Vercel preview before merge, and again after cutover)
- [ ] Coach login works with the new password; wrong password rejected; session expires.
- [ ] Coach dashboard loads clients, diagnostics, email log, reports.
- [ ] Client portal loads via token; check-in submits; Ask Alex answers.
- [ ] Diagnostic leader page loads; rater survey submits and is recorded.
- [ ] Report PDF still views in the leader portal (signed URL).
- [ ] Cron endpoints reject a request with no secret; accept the real cron.
- [ ] `/api/ask` rejects a request with no/invalid token.
- [ ] Supabase advisor: zero `rls_policy_always_true`, zero public-bucket-listing, zero anon-executable SECURITY DEFINER.

## Rollback
- App: revert the merge commit; Vercel redeploys the previous build.
- Database: `supabase-migration-v26-lockdown-rls.sql` has a companion `-- ROLLBACK` block recreating the prior permissive policies. Keep it until the new app has run clean for a week.

---

## One-time: generate the coach password hash (run locally, Node)
```js
const crypto = require('crypto');
const password = process.argv[2];                 // node hash.js "YourNewStrongPassword"
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${salt}:${hash}`);                   // store this in coach_settings.coach_password_hash
```
Also generate the session secret: `openssl rand -hex 32` → set as `COACH_SESSION_SECRET` in Vercel.
