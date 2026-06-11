# GPS Portal — Premortem & IT Audit (Pre-Engagement)

**Prepared:** June 9, 2026
**Trigger:** Workshop/Assessment + 14-Day Diagnostic engagement kicking off next week.
**Method:** Forensic review of the live code (`coach.html`, `client.html`, all 20 `api/*.js` functions, the workshop pages, `vercel.json`, migrations v2–v43), plus direct read-only queries against the live Supabase production database (`pbnkefuqpoztcxfagiod`) and its security advisors on June 9. This is verified against production, not inferred from docs.

---

## Read this first

Two things are true at once.

**You've fixed the big ones.** The June 3 premortem said the database was wide open, the coach password lived in the browser, the AI proxy was an open ATM, and the cron endpoints could be triggered by anyone. I checked all four against live production today. **All four are closed.** The v26 RLS lockdown is holding — every sensitive table (clients, diagnostics, the 351 confidential rater responses, coach_settings, admin_accounts) now denies the public key by default. Coach login is a real server-side signed session. Ask Alex requires a valid client token and caps spend server-side. The cron `manual_trigger` backdoor is gone. That's a serious amount of real hardening since June 3.

**But there's still a clean path to every confidential 360 report, and it runs straight through the surface you're using next week.** Two findings that look small in isolation chain into a full breach: a database *view* that still hands the public key every leader's name, email, and TP3 scores — and a storage bucket that's still public. One leaks the keys; the other is the unlocked door. Fix these two before the engagement and you've closed the last real hole.

Everything below is sorted so the fix-now items are unmistakable.

---

## What changed since June 3 (so you know the lock is real)

| June 3 finding | Status today | Evidence |
|---|---|---|
| #1 Every table open to the anon key (`USING(true)`) | **CLOSED** | Live advisors show sensitive tables as `rls_enabled_no_policy` = deny-all. The June 8 sweep confirms 0 permissive anon policies on sensitive tables. |
| #2 Coach password read & compared in the browser, `GPS2026` fallback | **CLOSED (one exception, see F3)** | `coach.html` now POSTs to a `coach-login` action; `coach-data.js` issues an HMAC-SHA256 signed session and verifies it server-side. |
| #4 `/api/ask` open AI proxy, CORS `*`, localStorage-only limit | **CLOSED** | `ask.js` validates the client token server-side, enforces a 30/day hard cap from the database, and locks CORS to `portal.gpsleadership.org`. |
| #5 Cron endpoints bypassable with `manual_trigger:true` | **CLOSED** | No `manual_trigger` anywhere in `api/`. Manual runs now require the `CRON_SECRET` bearer token; scheduled runs require the `x-vercel-cron` header. |
| Vercel function cap / 300s timeout | **CLOSED** | On Vercel Pro; caps no longer apply. |
| Escaped-backtick parse bug (May 29 / June 2 outages) | **HOLDING** | `coach.html` and `client.html` both scan to **0** escaped backticks. All 20 functions and 9 pages pass a syntax check. |

The remaining list is much shorter than June 3 — but it is not empty, and the top two are live.

---

## Part 1 — Failure Inventory (current)

| # | Failure Point | Lens | Priority | Likelihood | Impact |
|---|---|---|---|---|---|
| F1 | **`ghl_export_view` leaks confidential data to the public key.** This `SECURITY DEFINER` view bypasses RLS, and `anon` has `SELECT` on it. It exposes, per leader: name, email, role, company, **and every TP3 score** (trust, proactivity, productivity, overall impact, succession, self-scores) — plus the `diagnostic_id`. Anyone with the publishable key (it's in your HTML) can pull the whole table. | Technical / Security | **High** | 85% (exposure exists now) | High |
| F2 | **`diagnostic-reports` storage bucket is still public.** Confidential 360 PDFs are readable by anyone with the URL. The URL is `…/diagnostic-reports/{diagnostic_id}/report.pdf` — and F1 hands out every `diagnostic_id`. **F1 + F2 together = download every confidential report.** This is the exact data raters were promised would stay private. | Technical / Security | **High** | 80% | High |
| F3 | **`testimonial.js` still trusts the legacy, anon-writable `gps_settings` table for coach auth — with a `GPS2026` fallback.** `authCoach()` reads `gps_settings.coach_password` (plaintext) and falls back to `GPS2026` if absent. `gps_settings` has anon `INSERT`/`UPDATE USING(true)` — so an outsider can overwrite that password and authenticate to the testimonial/referral admin actions. | Technical / Security | **High** | 55% | Med-High |
| F4 | **All AI model strings are hardcoded to `claude-sonnet-4-6` in three files** (`ask.js`, `diagnostic.js`, `workshop-data.js`), no env var, no fallback. A model retirement takes down Ask Alex, **report generation, AND workshop summary/recommendation generation at the same moment** — i.e. the exact features the engagement runs on. | Technical / Availability | **High** | 35% | High |
| F5 | **No uptime or error monitoring.** Outages are still discovered live. There is no health check, no Sentry, no pager. For a live sponsor debrief, "the client tells you it's down" is the detector. | Technical / Operational | **High** | 60% | High |
| F6 | **Workshop/sponsor flow is the active churn zone.** Recent commits read "token leak," "sponsor→member conversion," "merge conflicts," "Overview empty state." The *code parses and the endpoints are well-guarded*, but this surface has changed the most and is least settled — exactly the one you're leading with. Highest risk of a data/logic bug surfacing live. | Technical / Usability | **High** | 50% | Med-High |
| F7 | **`org-assets` bucket is public.** Lower sensitivity (logos), but worth a conscious decision, not an accident. | Technical / Security | Medium | 70% | Low |
| F8 | **Global CORS `*` on every `/api/` route in `vercel.json`.** `ask.js` overrides itself, but the other endpoints still answer any origin. Lower risk now that auth is token-based, but it's a free tightening. | Technical / Security | Medium | 50% | Low-Med |
| F9 | **Four functions with mutable `search_path`** (`update_updated_at`, `update_updated_at_column`, `get_survey_scoreboard`, `increment_ask_alex`). Supabase WARN; low exploitability. | Technical / Security | Low | 20% | Low |
| F10 | **Hand-run migrations, no applied-state tracking, 43 files.** No single source of truth for what's actually live. Drift risk over time, not an engagement-week risk. | Technical / Operational | Medium | 40% | Medium |
| F11 | **Two giant single-file pages** (`coach.html` ~502KB, `client.html` ~441KB). Clean today (0 escaped backticks), but one stray character still kills the whole page silently. The git hook is your seatbelt; keep it on. | Technical | Medium | 40% (recurs) | High |
| F12 | **Bus factor of 1.** One person builds, deploys, and holds all context. Survival package exists and is current-ish, but recovery still depends on you being available. | People / Strategic | Medium | 50% | High |

### The Critical Three (for next week)

**F1 + F2 are one problem wearing two hats — fix them as a pair.** The view leaks the IDs; the public bucket serves the files. Closed together, the confidential 360 data is finally actually private. Left open, a single unauthenticated request enumerates every leader and downloads every report — during the exact engagement where you're asking raters to trust you with candor.

**F4 is your single point of AI failure.** Every AI feature the engagement uses — workshop summaries, recommendations, the diagnostic report — points at one hardcoded model string in three files. One retirement notice and all of it dies at once, with no fallback. Cheap to de-risk, expensive to discover live.

**F5 means you'll find out from the sponsor.** Without a health check and an alert, your first signal that the portal is down during a debrief is the client's face. Twenty minutes of monitoring setup changes that.

---

## Part 2 — Phased Remediation Plan

### Phase 1 — Before the engagement (this week)

**[F1] Close the `ghl_export_view` leak**
- **Action:** Revoke `SELECT` from `anon` (and `authenticated`) on `ghl_export_view`, and rebuild it as `SECURITY INVOKER` so it can never bypass RLS again. **First confirm what reads it** — almost certainly a Make.com/GHL export running on the service key, which is unaffected. If anything reads it with the publishable key, point that at a token/session-gated endpoint instead.
- **If you skip it:** The publishable key in your HTML returns every leader's identity and TP3 scores on one request.

**[F2] Make `diagnostic-reports` private**
- **Action:** Flip the bucket to private, and serve PDFs through a token-validated endpoint that returns a short-lived signed URL (the diagnostic/leader token already exists to gate it). **Do not flip it alone** — the leader and client portals currently fetch the public URL directly, so the app change and the bucket change must ship together, or the reports 404 mid-engagement.
- **If you skip it:** Every confidential report stays one guessed/leaked `diagnostic_id` away from download.

**[F3] Cut `testimonial.js` over to the real auth path**
- **Action:** Replace `authCoach()`'s `gps_settings` + `GPS2026` read with the same `verifyCoachSession()` the other endpoints use. Then retire the three legacy `gps_*` anon-write policies (see F-list). `gps_coach_uploads` is empty; `gps_notes` (5 rows) and `gps_settings` (11 rows) need a 60-second look before you drop the policies.
- **If you skip it:** A known default password (`GPS2026`) on an anon-writable table is a standing backdoor into your testimonial/referral admin actions.

**[F4] Move the model string to one env var with a fallback**
- **Action:** Add `CLAUDE_MODEL` (and `CLAUDE_FAST`) as Vercel env vars, read by all three files. Add a single fallback model on a non-OK response. Update `PORTAL_STATE.md` (still documents a retired model).
- **If you skip it:** The whole AI layer is one deprecation away from a simultaneous outage, edited under pressure in three places.

**[F5] Stand up minimum monitoring**
- **Action:** Add a tiny `/api/health` endpoint, point a free UptimeRobot/BetterStack monitor at `/coach`, `/workshop-room` (with a test token), and `/api/health`, and route alerts to your phone. Drop a free Sentry snippet into `coach.html` and `workshop-room.html`.
- **If you skip it:** The sponsor is your alerting system.

**[F6] Run one full dress rehearsal of the workshop flow on a preview**
- **Action:** On a Vercel preview, with `TEST `-prefixed seed data: create a workshop → upload a roster → send invites → submit pre + room surveys → aggregate → generate summary → **toggle Published** → open the sponsor `/workshop-room` link as the sponsor would → submit sponsor feedback. Then run the same for an assessment. Watch the network tab for any 4xx/5xx. This is the cheapest way to catch the next "token leak"-class bug before the sponsor does.
- **If you skip it:** The least-settled surface meets a live sponsor cold.

### Phase 2 — First 30 days

- **[F7]** Decide `org-assets` public-or-private deliberately; make private + signed if it ever holds anything but logos.
- **[F8]** Tighten `vercel.json` CORS from `*` to your origin; keep per-endpoint overrides.
- **[F11]** Keep the pre-commit/pre-push hooks installed on every machine you edit from; begin extracting the largest JS blocks out of `coach.html` so a failure is scoped, not total.

### Phase 3 — Before 90 days

- **[F9]** Set explicit `search_path` on the four flagged functions.
- **[F10]** Adopt a `schema_migrations` tracking table (or the Supabase CLI flow) so "what's live" has one answer. Reconcile the survival package.
- **[F12]** Do one real restore of a backup into a scratch Supabase project and confirm the portal runs against it — prove recovery, don't assume it.

### Phase 4 — Watch List

- **CORS `*`** — revisit when you add any legitimate external caller.
- **Survival package drift** — re-run the survival-package skill after this round of fixes.
- **Single-developer recovery** — quarterly "could someone else deploy this" dry run.

---

## Part 3 — Technical Fix List

**[High] F1 — `ghl_export_view` (SECURITY DEFINER) is anon-readable**
- **What breaks:** `GET /rest/v1/ghl_export_view?select=*` with the publishable key returns every leader's name, email, role, company, TP3 scores, and `diagnostic_id`, bypassing the RLS lockdown.
- **Fix:** `REVOKE SELECT ON public.ghl_export_view FROM anon, authenticated;` then recreate it `WITH (security_invoker = true)`. Confirm the GHL/Make consumer uses the service key first (it almost certainly does). Verifiable immediately via the Supabase security advisor (the ERROR should clear).

**[High] F2 — `diagnostic-reports` bucket public**
- **What breaks:** Confidential PDFs at predictable `{diagnostic_id}/report.pdf` paths are world-readable; F1 supplies the IDs.
- **Fix:** Set bucket `public = false`. Add a `get-report` action to a token-gated endpoint that returns a 60-second signed URL after validating the leader/coach token. Update `diagnostic-leader.html` / `client.html` to call it instead of the raw public URL. Ship both together.

**[High] F3 — `testimonial.js` legacy auth + `GPS2026` fallback**
- **What breaks:** `authCoach()` reads `gps_settings.coach_password` (plaintext, anon-writable table) and falls back to `GPS2026`.
- **Fix:** Replace with `verifyCoachSession(body.session)` like `coach-data.js`. Then `DROP POLICY` the anon write policies on `gps_settings`, `gps_notes`, `gps_coach_uploads` after a quick check of the 5 + 11 rows.

**[High] F4 — Hardcoded model string in three files**
- **What breaks:** `claude-sonnet-4-6` literal in `ask.js`, `diagnostic.js`, `workshop-data.js`; retirement = simultaneous AI outage.
- **Fix:** One `CLAUDE_MODEL` env var read everywhere; on a non-OK Anthropic response, retry once against a fallback model; surface a clean "assistant briefly unavailable" message instead of a raw error.

**[High] F5 — No monitoring**
- **What breaks:** No detector for an outage during a live session.
- **Fix:** Add `/api/health` (returns 200 + a cheap DB ping). External uptime monitor on `/coach`, `/workshop-room?token=TEST…`, `/api/health`. Sentry snippet in the two pages clients see.

**[Med] F8 — Global CORS `*`**
- **Fix:** Set `Access-Control-Allow-Origin` to `https://portal.gpsleadership.org` in `vercel.json`; keep endpoint-level overrides for any legitimate cross-origin need.

**[Med] F10 — Migration drift**
- **Fix:** `schema_migrations` table written at the end of each script, or adopt the Supabase CLI. One source of truth.

**[Low] F9 — Mutable `search_path`**
- **Fix:** `ALTER FUNCTION … SET search_path = public, pg_temp;` on the four flagged functions.

---

## Do this next

In order, this week: **(1)** revoke anon on `ghl_export_view` and make it `security_invoker`; **(2)** make `diagnostic-reports` private behind a signed-URL endpoint, shipped with the app change; **(3)** move `testimonial.js` onto the real session check and drop the legacy anon policies; **(4)** put the model string in one env var with a fallback; **(5)** stand up a health check + uptime alert. Then run **one full workshop dress rehearsal on a preview** before the sponsor sees it. That closes every live exposure and de-risks the surface you're leading with.

All of this goes on a branch → Vercel preview → your sign-off → merge, per the safe-build workflow. Nothing touches production without a green preview and your approval.

---

## Addendum — Workshop / Assessment + Sponsor Deep Dive (your priority surface)

This is where you keep hitting issues, so I traced the full sponsor path through `coach.html`, `workshop-data.js`, `workshop-sponsor.js`, the v40/v43 schema, and the live data. The code parses and the endpoints are well-guarded — the problem is structural, not a crash. **A workshop's sponsor is stored three different ways that are never kept in sync**, and the different screens read different ones.

The three keys for "who is the sponsor":
1. `workshops.sponsor_client_id` — single sponsor, set by the **Create Workshop form**.
2. `workshop_sponsors` junction (client_id) — multi-sponsor, written by the **"Add sponsor" button** on an existing workshop.
3. The coach **"Sponsor" filter** (`SPONSOR_EMAILS`) — built from the **Decision Room `sponsors` table by email**, which is a different table entirely.

### Confirmed live symptoms

| ID | Finding | Evidence (live) | Impact |
|---|---|---|---|
| **W1** | **Sponsors added after creation vanish from the Overview + sponsor dashboard.** The "Add sponsor" button writes only the junction; the Overview tab and `workshop-sponsor.js` read `sponsor_client_id`, which stays null. | **"JMAA Management Team Pulse Survey"** assessment: **2 sponsors in the junction, `sponsor_client_id` = null.** Sponsor dashboard would show "no sponsor." | High — your real JMAA assessment shows no sponsor today. |
| **W2** | **Workshop sponsors never appear in the coach "Sponsor" filter.** That filter is built from the Decision Room `sponsors` table by email; workshop sponsors live in `workshop_sponsors` by client_id. The two never meet. | `SPONSOR_EMAILS` ← `sponsors.email` only (coach.html:1842). 7 workshop sponsors exist; none are sourced from there. | High — "view sponsor profile" / filtering is unreliable. |
| **W3** | **Sponsor client records carry no role flag, and "Add sponsor" can mutate a real coaching client.** New sponsors are inserted as plain `clients` rows (no `is_sponsor`/`is_workshop_participant`). On an email match to an existing client, the code patches `title` onto that shared row. | **Su Nu** is `in_coaching_program=true` AND a workshop sponsor on the **same client row**. | Med-High — risk of editing a coaching client's record via the sponsor flow ("sponsor→member" tangle). |
| **W4** | **Orphaned junk assessments with live sponsor tokens.** Several gibberish-titled assessments sit in `setup` with sponsor tokens and no participants — created while hitting the bugs above. | `kgik`, `ygiyg`, `tdbnartn` (and a stray `Susu`) — assessments, status `setup`, 0 participants. | Med — clutter + live tokens; confirm which are disposable. |
| **W5** | **Email-match hijack on sponsor add.** Both add paths reuse any existing client with a matching email as the sponsor — including a coaching client or a participant — silently merging roles onto one row. | Same root as W3; matches the recent "sponsor→member conversion" commits. | Med — identity collisions across roles. |

### Recommended fix (one decision drives the rest)

**Pick the junction (`workshop_sponsors`) as the single source of truth**, and make everything else conform:
- **W1:** In `add-workshop-sponsor` / `remove-workshop-sponsor`, keep `workshops.sponsor_client_id` in sync (set it to the primary sponsor when null; repoint or clear on removal). Have the Overview tab and `workshop-sponsor.js` read the junction first, `sponsor_client_id` as fallback. Backfill the JMAA row now.
- **W2:** Build the coach "Sponsor" bucket from `workshop_sponsors` (+ Decision Room `sponsors`) by **client_id**, not email.
- **W3/W5:** Add an `is_sponsor` flag on `clients` (migration), set it on attach; stop patching `title` onto a matched coaching client — store the sponsor's workshop title on the junction row instead. Warn (don't silently merge) when an added email already belongs to a coaching client or participant.
- **W4:** Delete the confirmed-junk `setup` assessments (FK-safe), after you confirm which are disposable.

This is a coupled migration + `workshop-data.js` + `coach.html` + `workshop-sponsor.js` change — it goes on a branch, gets a Vercel preview, a full create→roster→survey→aggregate→publish→sponsor-dashboard dress rehearsal with `TEST ` data, your sign-off, then merge.

---

*Verified against live production (read-only except the applied F1 fix) on June 9, 2026.*
