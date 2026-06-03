# GPS Leadership Portal — Technical Premortem

**Prepared:** June 3, 2026
**Scope:** Full portal — coach dashboard, client portal, 14-Day Diagnostic, Ask Alex, the Supabase database, the `api/` serverless layer, and the Vercel/GitHub deploy pipeline.
**Method:** Forensic review of the survival package, `PORTAL_STATE.md`, every `api/*.js` file, the RLS policies in the migration files, `vercel.json`, the deploy/check scripts, and the coach login path.

---

## What I Analyzed

The portal is a two-product delivery platform (90-day coaching + 14-Day Diagnostic) built as single-file vanilla HTML pages talking to a Supabase Postgres database, with a thin layer of Vercel serverless functions for anything that needs a secret key. It is built and operated by one person. The recurring breakages of the last two weeks (silent JavaScript parse errors taking down login, a Vercel build that failed for days without anyone noticing) are not random bad luck. They are the predictable output of three structural conditions: **a database whose security exists only in the UI, a deploy pipeline with no staging and no monitoring, and a codebase concentrated in two enormous files where one stray character kills the whole page.** This premortem assumes the portal has already failed catastrophically and works backward through why.

The single most important finding: **the "password-protected coach dashboard" and "clients can only see their own data" are both false.** Every table is readable and writable by the public anon key, which is printed in your HTML and hardcoded in your repo. Everything else below matters, but this is the one that turns a bug into a breach.

> **This was verified against your live production database on June 3, 2026 — it is not theoretical. See the "Live Production Verification" addendum at the end of this document for the confirmed policy list, exposed row counts, and three additional exposures the survival package never documented.**

---

## Part 1 — Complete Failure Inventory

| # | Failure Point | Lens | Priority | Likelihood | Impact |
|---|--------------|------|----------|------------|--------|
| 1 | **Permissive RLS on every table** — all policies are `USING (true)` for `anon`. The anon key (public, in the HTML and hardcoded in `diagnostic.js`) can read and write every client, diagnostic, rater response, and Ask Alex log. | Technical / Security | **High** | 95% (exposure exists now) | High |
| 2 | **Coach password read client-side in plaintext** — `checkPassword()` pulls `coach_password` from `coach_settings` via the anon key and compares in the browser. Anyone can read it, or skip the check entirely. Hardcoded fallback `GPS2026`. | Technical / Security | **High** | 90% | High |
| 3 | **Confidential 360 PDF reports are world-readable** — `diagnostic-reports` bucket is public with anon INSERT/UPDATE. Anon can read every `report_pdf_url` from the DB, then fetch every report. Anyone can also overwrite them. | Technical / Security | **High** | 80% | High |
| 4 | **`/api/ask` is an open, unauthenticated AI proxy** — CORS `*`, no token required, attacker controls `system` + `messages`. Free Claude Sonnet billed to your Anthropic account; usable as a general proxy under GPS's name. The 20/day limit is client-side localStorage only. | Technical / Financial | **High** | 70% | High |
| 5 | **Cron endpoints bypassable via `manual_trigger:true`** — `send-reminders`, `survey-reminders`, `diagnostic?action=reminders` all accept `{manual_trigger:true}` with no secret. Anyone can trigger mass client emails on repeat. | Technical / Security | **High** | 60% | High |
| 6 | **Two giant single-file pages with no error boundary** — `client.html` (406KB) and `coach.html` (342KB). One bad character anywhere in the inline script kills the entire page silently, no console error. This is the exact May 29 / June 2 incident class. | Technical / Usability | **High** | 85% (recurs) | High |
| 7 | **No staging environment** — `git push` to main deploys straight to production. No preview gate between editor and live clients. | Operational | **High** | 80% | High |
| 8 | **No uptime monitoring or error tracking** — outages were discovered live, mid-coaching-session. `smoke-test.sh` is manual and only runs if you remember. | Technical / Operational | **High** | 75% | High |
| 9 | ~~**Vercel function count at the hard limit**~~ — **RESOLVED June 2026:** account upgraded to Vercel Pro; the 12-function cap no longer applies. New endpoints can be added as standalone files again. | Technical | ~~High~~ Resolved | — | — |
| 10 | ~~**maxDuration / plan mismatch**~~ — **RESOLVED June 2026:** on Vercel Pro the 300s `diagnostic.js` timeout is supported, so report generation no longer risks a silent 60s cap. | Technical | ~~High~~ Resolved | — | — |
| 11 | **Hand-run migrations, no tracking, no v21, contradictory docs** — migrations are pasted into the Supabase SQL editor by hand. The survival package says run v2–v19 in one section and v2–v25 in another, and mislabels v14 as "RLS policies" when it's email templates. No record of what's actually applied. | Technical | **High** | 60% | Med-High |
| 12 | **Pinned model string can be deprecated** — `claude-sonnet-4-6` hardcoded in `ask.js` and `diagnostic.js`. `PORTAL_STATE.md` still shows the old `claude-sonnet-4-20250514`. When a model is retired, all AI features fail at once. | Technical | **Medium** | 45% | High |
| 13 | **No tested database restore path** — daily code zips exist, but DB data backup/restore has never been exercised. On Supabase's lower tiers, point-in-time recovery is limited. | Technical / Operational | **Medium** | 35% | High |
| 14 | **Some migrations are not safely re-runnable** — e.g. v16 `CREATE POLICY` with no `DROP POLICY IF EXISTS` first. Re-running errors out; partial application leaves drift. | Technical | **Medium** | 50% | Medium |
| 15 | **`Math.random()` token generation** — portal access tokens are generated with `Math.random()`, not a crypto RNG. High length keeps brute force impractical, but it's predictable in principle and these tokens are the only thing protecting client data. | Technical / Security | **Medium** | 25% | Medium |
| 16 | **CORS `*` on all `/api/` routes** — any website can call your endpoints. This is the amplifier that makes #4 and #5 trivially abusable from a browser anywhere. | Technical / Security | **Medium** | 60% | Medium |
| 17 | **Ask Alex has no server-side failure UX** — if Anthropic is rate-limited or over budget, `ask.js` returns the raw error; clients can hit a dead assistant mid-session. | Technical / Usability | **Medium** | 40% | Medium |
| 18 | **Bus factor of 1** — one person is sole developer, sole operator, and sole holder of all platform context. AI-generated code that isn't fully understood compounds recovery time when something breaks. | People / Strategic | **Medium** | 50% | High |
| 19 | **Secrets/identifiers committed to the repo** — Supabase project URL and the publishable anon key are hardcoded as fallbacks in multiple `api/*.js` files. Not the service key (good), but it normalizes committing identifiers and widens the blast radius if the repo is ever public. | Technical / Security | **Low-Med** | 40% | Medium |
| 20 | **`accept-terms.js` / `start-sprint.js` etc. trust any token with no rate limiting** — minor abuse surface (consent spoofing, sprint churn), low impact but unbounded. | Technical | **Low** | 30% | Low |

### The Critical Three

If you fix nothing else, fix these, because each one silently guarantees the others become catastrophic. **(1) The database is open.** Permissive `anon USING(true)` policies plus a public key in your HTML means there is no real access control on any client data, confidential rater feedback, or the coach password — the lock is painted on. **(6 + 7 + 8) The delivery pipeline has no safety net.** Giant single-file pages, no staging, and no monitoring mean a one-character mistake reaches live clients instantly and you find out when a CEO can't log in during a session. **(4 + 5) Your spend and your sending reputation are exposed.** The open AI proxy and the bypassable cron endpoints let a stranger run up your Anthropic bill and blast your clients with email, from your domain. These three compound everything below them.

---

## Part 2 — Phased Remediation Plan

### Phase 1 — Fix Before You Do Anything Else (this week)

These are live exposures. Until they're closed, treat client and rater data as effectively public.

**[1] Lock down RLS — move all data access behind the service key**
- **Action:** Stop trusting the browser. Replace the blanket `anon USING(true)` policies with deny-by-default, and route every read/write through serverless functions that use the service key and a token/password check. Concretely: (a) revoke the broad `FOR ALL TO anon USING(true)` policies on `clients`, `diagnostics`, `diagnostic_raters`, `diagnostic_responses`, `diagnostic_report_drafts`, `ask_alex_log`, `coach_settings`, `admin_accounts`, `email_log`; (b) the client portal already has `get-client.js` as the pattern — extend that pattern so the browser never queries Supabase directly with the anon key for anything sensitive; (c) the survey/diagnostic pages that currently use the anon key directly get a thin server endpoint each. This is the big one and it touches a lot, so do it on a branch, table by table, testing each page as you go.
- **If you skip it:** Anyone who views source on `/coach` has read/write access to every client, every confidential 360, and the coach password. This is a reportable data breach waiting to happen and it's a contractual problem with the executives whose raters were promised confidentiality.

**[2] Get the coach password out of the browser**
- **Action:** Move login to a serverless endpoint (`api/coach-login.js`) that checks a **hashed** password (bcrypt/argon2) server-side using the service key and returns a signed, expiring session token. Remove the client-side `coach_settings` read and the `GPS2026` fallback entirely. Store only the hash.
- **If you skip it:** The dashboard password is one console command away for anyone, and admin accounts the same. "Password-protected" is currently cosmetic.

**[3] Make the diagnostic report bucket private**
- **Action:** Set the `diagnostic-reports` bucket to **private**. Serve PDFs through a serverless endpoint that validates the leader/coach token and returns a short-lived signed URL. Remove anon INSERT/UPDATE; uploads go through the (now authenticated) coach endpoint.
- **If you skip it:** Every confidential leadership report is fetchable by anyone who can read the diagnostics table — which, until #1 is done, is everyone.

**[4] Authenticate `/api/ask` and move rate limiting server-side**
- **Action:** Require a valid client `token` (you already pass it for logging — make it mandatory and verify it against `clients`). Enforce the daily cap in the database, not localStorage. Lock CORS to your own origin. Set an Anthropic monthly spend alert/cap as a backstop.
- **If you skip it:** A stranger runs your Claude bill up overnight and you have no ceiling.

**[5] Close the cron bypass**
- **Action:** Remove the `manual_trigger:true` shortcut. Manual runs must present the `CRON_SECRET` bearer token like everything else. Verify all three cron endpoints (`send-reminders`, `survey-reminders`, `diagnostic?action=reminders`).
- **If you skip it:** Anyone can POST a flag and trigger mass emails to your clients, repeatedly — burning Resend quota and your domain's deliverability reputation.

### Phase 2 — First 30 Days (stop the recurring outages)

**[6] Add a real pre-deploy gate beyond `check.sh`**
- **Action:** `check.sh` catches the two bugs you've already hit; it won't catch the next class. Add: (a) a headless smoke test that actually loads `/coach` and `/client` in a real browser engine and asserts the login screen renders (catches runtime errors `node --check` misses); (b) run it automatically in a GitHub Action on every push, not just locally. Keep the git hook as the first line.
- **If you skip it:** The next silent parse/runtime error ships to a live client exactly like May 29 did.

**[7] Stand up a staging environment**
- **Action:** Use Vercel preview deployments (you get them free per-branch). Adopt a rule: changes land on a `staging` branch, you smoke-test the preview URL, then merge to main. Never edit-and-push to production again.
- **If you skip it:** Production stays your test environment, with clients in it.

**[8] Add uptime + error monitoring**
- **Action:** Put a free uptime monitor (UptimeRobot/BetterStack/Vercel's own) on `/coach`, `/client`, and a lightweight `/api/health` you add. Add a free Sentry project to both HTML pages to capture client-side JS errors with a stack trace. Route alerts to your phone/email.
- **If you skip it:** You keep discovering outages from clients instead of from a pager — the worst possible detector.

**[9 + 10] Resolve the Vercel plan/function reality**
- **Action:** Confirm which plan you're actually on (the docs contradict themselves). If Hobby: you're over the 12-function cap with 13 files and your 300s `maxDuration` is being silently capped at 60s — both are live risks, and report generation may already be timing out. Upgrade to Pro (this removes the cap and the timeout ceiling in one move and is cheap insurance for a revenue-critical system) **or** consolidate endpoints and split long report generation into an async job. Pick one deliberately.
- **If you skip it:** Your next feature fails the build, or long reports keep dying at 60 seconds with no clear cause.

### Phase 3 — Before the 90-Day Mark (durability)

**[11] Put migrations under version control discipline**
- **Action:** Adopt the Supabase CLI migration workflow (or at minimum a single `migrations_applied` table you insert into at the end of each script). Reconcile the survival package: it's wrong about v14 and contradicts itself on v19 vs v25. One source of truth for "what schema is live."
- **If you skip it:** Code and database drift until a query references a column that isn't there, in production.

**[12] Centralize and soften the model reference**
- **Action:** Move the model string to one env var (`CLAUDE_MODEL`) read by both `ask.js` and `diagnostic.js`. Update `PORTAL_STATE.md` (still shows the retired `claude-sonnet-4-20250514`). Add a fallback model on error.
- **If you skip it:** A model retirement takes down Ask Alex and report generation simultaneously, and you edit it in two-plus places under pressure.

**[13] Test a database restore end to end**
- **Action:** Once, actually restore your `export-backup.js` output (and/or a Supabase snapshot) into a throwaway project and confirm the portal runs against it. Schedule the export if it isn't already, and store copies off-Supabase.
- **If you skip it:** Your backups are a hope, not a recovery plan, and you find out which during the incident.

**[14] Make every migration re-runnable, and [17] add Ask Alex failure UX**
- **Action:** Add `DROP POLICY IF EXISTS` before each `CREATE POLICY` (v16 and any siblings). In `ask.js`, catch non-OK Anthropic responses and return a clean "Alex's assistant is briefly unavailable, try again in a moment" instead of a raw error.

### Phase 4 — Watch List

- **[15] `Math.random()` tokens** — Monitor: when you next touch import/token code, switch to `crypto.randomUUID()` or `crypto.getRandomValues`.
- **[16] CORS `*`** — Monitor: tighten to your origin as part of Phase 1 #4; revisit if you ever add a legitimate external caller.
- **[18] Bus factor of 1** — Monitor: keep the survival package current (it's already drifting); consider a quarterly "can someone else deploy this" dry run.
- **[19] Identifiers in repo** — Monitor: confirm the GitHub repo is private; rotate the publishable key if it ever goes public.
- **[20] Unrated minor endpoints** — Monitor: fold token-validation + light rate limiting in when you refactor the API layer for #1.

---

## Part 3 — Technical Fix List

Ordered High → Low. Specific enough to act on directly.

**[High] Permissive RLS exposes all data to the anon key**
- **What breaks:** Policies like `CREATE POLICY ... FOR ALL TO anon USING (true) WITH CHECK (true)` on `clients`, `diagnostics`, `diagnostic_raters`, `diagnostic_responses`, `diagnostic_report_drafts`, `ask_alex_log`, `coach_settings`, and `admin_accounts` mean the public anon key (in your HTML, and hardcoded as `sb_publishable_nu9GXG...` in `diagnostic.js`) can read and write everything.
- **Fix:** Drop the blanket anon policies. Default-deny. Move all sensitive reads/writes behind serverless functions using `SUPABASE_SECRET_KEY` plus a token/password check, following the existing `get-client.js` pattern. Do it on a branch, one table and one page at a time, testing each. This is the root cause behind findings 1, 2, and 3.

**[High] Coach password stored and verified in the browser**
- **What breaks:** `checkPassword()` in `coach.html` (line ~1428) reads `coach_password` from `coach_settings` with the anon client and compares in JS; plaintext storage, with a `GPS2026` fallback. `admin_accounts.password` is read the same way.
- **Fix:** New `api/coach-login.js` that verifies a bcrypt/argon2 **hash** server-side and issues a signed, expiring session token. Delete the client-side read and the hardcoded fallback. Store only hashes; force a password reset after cutover.

**[High] `diagnostic-reports` storage bucket is public + anon-writable**
- **What breaks:** Bucket is `public: true` with `gps_diag_reports_insert/update` allowing anon writes and public SELECT. Confidential PDFs are world-readable by URL and overwritable by anyone.
- **Fix:** Set bucket to private. Replace public reads with a token-validated serverless endpoint that returns a short-lived signed URL. Remove anon INSERT/UPDATE; route uploads through the authenticated coach endpoint.

**[High] `/api/ask` is an open AI proxy**
- **What breaks:** No auth required (`token` is optional, logging-only), CORS `*`, caller supplies `system` and `messages`. Free Sonnet calls on your key; the `prefill` route is the same with Haiku. Rate limit is client-side localStorage only.
- **Fix:** Require and verify `token` against `clients`. Enforce the daily cap in Postgres (count `ask_alex_log` rows for that client/day). Restrict `Access-Control-Allow-Origin` to your domain. Set an Anthropic spend cap/alert.

**[High] Cron endpoints bypass the secret with `manual_trigger:true`**
- **What breaks:** `send-reminders.js` (line 68) and the diagnostic/survey reminder handlers authorize if `req.body.manual_trigger === true`, with no secret. Public can trigger mass email.
- **Fix:** Remove the `manual_trigger` branch. Require `Authorization: Bearer ${CRON_SECRET}` for manual runs; keep the `x-vercel-cron` header check for scheduled runs.

**[High] Single-file pages fail silently and entirely on one bad token**
- **What breaks:** A `\`` or an SVG/special char inside a template literal throws a parse error that kills the whole inline `<script>`; the browser shows nothing in the console. Two 350–400KB files, no isolation.
- **Fix:** (a) Add a GitHub Action that loads each page in a headless browser and asserts the login/portal renders — catches runtime errors `node --check` cannot. (b) Add Sentry to capture client-side errors with stack traces. (c) Over time, extract the largest JS blocks into separate `.js` files so a failure is scoped, not total.

**[High] No staging; push goes straight to production**
- **What breaks:** `deploy.sh` commits and pushes to main, which auto-deploys live. No gate between your editor and a client mid-session.
- **Fix:** Use Vercel preview deployments per branch. Land on `staging`, smoke-test the preview URL, then merge to main. Encode the rule in `deploy.sh`.

**[High] Vercel function cap + maxDuration mismatch**
- **What breaks:** 13 files in `api/` vs Hobby's 12-function cap (already caused a multi-day silent build failure via `import-clients.js`). `vercel.json` sets `diagnostic.js` to 300s while the code comment says it needs Pro — on Hobby, 60s is the ceiling and long report generations time out.
- **Fix:** Confirm the actual plan. Upgrade to Pro (removes both limits, cheap for a revenue system) or consolidate endpoints and move report generation to an async pattern. Add the function count to `check.sh`'s hard-fail (it currently warns at 11).

**[Medium] Pinned model string in two files; docs show a stale model**
- **What breaks:** `claude-sonnet-4-6` is hardcoded in `ask.js` and `diagnostic.js`. On model retirement, both fail. `PORTAL_STATE.md` still documents `claude-sonnet-4-20250514`.
- **Fix:** One `CLAUDE_MODEL` env var read everywhere; add an on-error fallback model; correct the docs.

**[Medium] Hand-run migrations with no applied-state tracking**
- **What breaks:** Scripts are pasted into the SQL editor; nothing records what's live; the survival package is internally contradictory and mislabels v14. Drift between code expectations and the real schema.
- **Fix:** Adopt the Supabase CLI migration flow, or add a `schema_migrations` table each script writes to. Reconcile the survival package to one accurate schema list.

**[Medium] Untested DB restore**
- **What breaks:** Backups exist as zips; no one has restored them. Recovery time and completeness are unknown.
- **Fix:** Do one full restore into a scratch Supabase project and run the portal against it. Automate and off-site the export.

**[Medium] Non-idempotent migrations**
- **What breaks:** v16 `CREATE POLICY` with no preceding `DROP POLICY IF EXISTS` errors on re-run, leaving partial state.
- **Fix:** Add `DROP POLICY IF EXISTS` (or `CREATE ... IF NOT EXISTS` where supported) to every policy/object migration.

**[Medium] `Math.random()` for access tokens**
- **What breaks:** Tokens — the only thing gating client data once RLS is fixed — come from a non-crypto RNG.
- **Fix:** `crypto.randomUUID()` or `crypto.getRandomValues` in `import-clients.js` and anywhere else tokens are minted.

**[Low] CORS `*` everywhere**
- **What breaks:** Any origin can call your API; amplifies the proxy/cron abuse above.
- **Fix:** Restrict `Access-Control-Allow-Origin` to your domain in `vercel.json` and per-endpoint headers.

**[Low] Identifiers hardcoded in repo**
- **What breaks:** Supabase URL + publishable anon key sit as fallbacks in several `api/*.js` files.
- **Fix:** Rely on env vars only; confirm the repo is private; rotate the publishable key if exposure is ever possible.

---

## Do This Next

This week, in order: **(1)** put every sensitive table behind the service key and kill the open anon policies; **(2)** move the coach password to a hashed server-side check; **(3)** make the report bucket private; **(4)** require a token on `/api/ask` and cap spend; **(5)** remove the `manual_trigger` cron bypass. That closes every live exposure. Then in the first 30 days, add the GitHub-Action smoke test, a staging branch, and uptime + Sentry monitoring so the next mistake gets caught before a client ever sees it. Start finding #1 on a branch today — it's the largest change and the one that turns the rest from "bugs" into "not a breach."

---

## Addendum — Live Production Verification (June 3, 2026)

I connected to the live `GPS-portal` Supabase project (`pbnkefuqpoztcxfagiod`, region us-west-2) and confirmed the findings directly against production, rather than inferring them from the migration files. The static review was accurate, and verification surfaced three additional exposures the survival package never documented.

**Confirmed: RLS is enabled on every table — and that is the false comfort.** All tables show `rowsecurity = true`. But "RLS on" only means policies are evaluated; the policies themselves grant the public `anon` role unrestricted access. Supabase's own security advisor flagged this as `rls_policy_always_true` on, among others: `clients`, `coach_settings`, `admin_accounts`, `checkins`, `diagnostics`, `diagnostic_raters`, `diagnostic_responses`, `diagnostic_report_drafts`, `diagnostic_team_reports`, `stakeholders`, `survey_responses`, `survey_tokens`, `ask_alex_usage`. Read access is equally open via `SELECT ... USING (true)` on the rest. So the lock icon you'd see in the Supabase table editor is genuinely misleading here — every table is locked *and* wide open at the same time.

**Confirmed exposed data, with live counts as of June 3, 2026:**

| Data | Rows | What the anon key can do |
|------|------|--------------------------|
| `clients` (CEO PII, goals, tokens) | 23 | read + write + delete |
| `diagnostics` | 3 | read + write |
| `diagnostic_responses` (confidential 360 rater feedback) | 351 | read + write |
| `ask_alex_log` (clients' private leadership questions) | 3 | read |
| `coach_settings.coach_password` | 1 | **read and overwrite** |
| `admin_accounts` | 0 | read (currently empty) |

The 351 confidential rater responses are the most sensitive item: raters were promised their individual answers would never be shared, and right now any party with the public key can read all of them. The `coach_settings` policy is `ALL` with `USING(true) WITH CHECK(true)`, so the dashboard password isn't just readable — it can be **changed** by an outside party, locking you out.

**Three exposures not in the survival package (documentation drift):**
1. `ghl_export_view` is a `SECURITY DEFINER` view (advisor level: **ERROR**) — it runs with the creator's privileges and bypasses RLS for whoever queries it.
2. `gps_notes` and `gps_coach_uploads` tables have fully open `ALL USING(true)` policies (read/write/delete) and aren't mentioned anywhere in your docs — meaning they're in production but outside your own change-control awareness.
3. Two `SECURITY DEFINER` RPC functions (`get_survey_scoreboard`, `increment_ask_alex`) are executable by `anon` over the public REST API.

**Storage:** advisor confirms the `diagnostic-reports` bucket is public *and* has a broad SELECT policy that lets anyone **list** every file in it, not just fetch a known URL.

**Critical implication for the fix sequence:** because the live application authenticates and reads through the anon key against these open policies (coach login reads `coach_settings`; client/survey/diagnostic pages read and write directly), flipping the policies to deny-by-default *without* the matching app-layer changes would instantly take the live portal down for current clients. This is precisely why verification came before any code change: the RLS lockdown (Phase 1, #1) must ship as a **coupled database + app-layer migration on a branch**, not as a standalone SQL change against production. No changes were made to production during this verification — all queries were read-only.

**Lower-severity advisor notes** (worth doing during Phase 3 cleanup, not emergencies): four functions have a mutable `search_path` (`update_updated_at`, `increment_ask_alex`, `get_survey_scoreboard`, `update_updated_at_column`) — set an explicit `search_path` to harden them.
