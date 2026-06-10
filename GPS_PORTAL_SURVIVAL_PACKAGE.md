# GPS Leadership Portal — Survival Package
### Everything needed to recreate this system from scratch

**Last updated:** June 9, 2026 (Security hardening F1/F3/F4/F5/F9; GPS 4.0 scoring standard platform-wide; client-added-questions split; Employee vs Session NPS; sponsor-model unify + dashboard-first portal; assessment question tooling — see Section 17. Prior: PWA/RBAC/nav — Section 16; Workshop Module — Section 15; Decision Room — Section 14)
**GitHub repo:** https://github.com/GPSleadership/gps-portal
**Live URL:** https://portal.gpsleadership.org
**Coach dashboard:** https://portal.gpsleadership.org/coach
**Client portal:** https://portal.gpsleadership.org/client

---

## 17. June 9, 2026 — Security hardening, 4.0 scoring standard, added-questions, NPS, sponsor model

**Database migrations (all applied to prod via MCP; files in repo):**
- **v44 — lock `ghl_export_view` (F1, was the one live data leak).** The view was `SECURITY DEFINER` with `SELECT` granted to `anon`/`authenticated`, so the publishable key could read every leader's name/email/role + TP3 scores + `diagnostic_id`, bypassing the v26 RLS lockdown. Fix: `ALTER VIEW … SET (security_invoker = true)` + `REVOKE SELECT … FROM anon, authenticated`. Verified no live consumer (Make.com scenarios pull FROM GoHighLevel; they don't read this view).
- **v45 — unify the workshop sponsor model.** Added `clients.is_sponsor` (flag), `workshop_sponsors.sponsor_title` (per-engagement title, so we stop patching a shared client row). Backfilled `is_sponsor` for existing sponsors and synced `workshops.sponsor_client_id` from the `workshop_sponsors` junction where it had drifted to NULL (this is what made JMAA's sponsors show as "none").
- **v46 — pin `search_path` (F9)** on `update_updated_at`, `update_updated_at_column`, `get_survey_scoreboard`, `increment_ask_alex`. Advisor WARN cleared.

**New serverless function:** `api/health.js` → `/api/health`. Returns 200 when the DB is reachable and `SUPABASE_SECRET_KEY` is present (503 otherwise). Point UptimeRobot/BetterStack here. Registered in `vercel.json` (maxDuration 10).

**Security posture after today:** F1 (data leak) and F3 (testimonial auth) CLOSED; F4/F5/F9 done. **F2 deferred** — `diagnostic-reports` bucket is still public, but it's no longer enumerable now that F1 closed (the IDs aren't leaked anywhere), so it's defense-in-depth, not a live hole. F2 = add a token-gated signed-URL endpoint + update the leader/coach/team-report surfaces, THEN flip the bucket private; do it on a branch with a preview test, never a blind flip. **F8 (CORS) consciously skipped** — every endpoint is token/session-authed so it's low value, and tightening risks conflicting `Access-Control-Allow-Origin` headers with functions that set their own.

**F3 — `api/testimonial.js` coach auth cutover.** Was reading `gps_settings.coach_password` (plaintext) with a hardcoded `GPS2026` fallback — and `gps_settings` is anon-writable, so an outsider could overwrite the password and authenticate. Replaced `authCoach(password)` with `verifyCoachSession(session)` (HMAC-SHA256, same signed session as `coach-data.js`; needs `COACH_SESSION_SECRET`). No frontend currently calls these coach actions, so nothing breaks; a future testimonial-admin UI must send the coach session token as `session`.
- **NOTE — legacy `gps_*` anon policies intentionally LEFT in place.** `gps_settings`, `gps_notes`, `gps_coach_uploads` still have anon UPDATE/INSERT `USING(true)` policies (advisor WARN). They are NOT retired because `gps-ea-console.html` and `gps-executive-console*.html` read/write those tables directly with the anon key. Securing them is a separate project: route those consoles through an authed endpoint first, then drop the policies.

**Model strings → env vars (F4).** `ask.js`, `diagnostic.js`, `workshop-data.js` now read `CLAUDE_MODEL` / `CLAUDE_FAST` (and `CLAUDE_REPORT_MODEL` in diagnostic.js) from env, defaulting to today's models. A model retirement is now a one-place Vercel env change, not a 3-file edit.

**GPS 4.0 scoring standard — platform-wide (no rounding up).** 4.0–5.0 = strength (keep/grow); 3.0–3.99 = development zone (counts as a 3; under the bar; "not good enough," never "solid"); 1.0–2.99 = red flag (role-fit). Enforced in `findings()` in `workshop-sponsor.js` + `workshop-data.js`, the `workshop-room.html` narrative/labels/colors + a "Why we measure against a 4.0 bar" callout under the TP3 tiles, and `diagnostic.js` (tier scale rewritten so 3.x is never "Solid"; verbatim 4.0 standard inserted at the top of the report's Overview). The workshop recommendation engine's "weak" threshold moved 3.5 → 4.0, so a development recommendation fires unless every theme is 4+.

**Client-added-questions split (measurement integrity).** The TP3 Index is now computed from STANDARD questions ONLY (`workshop_questions.source = 'standard'`). Client-added questions (`ai_suggested` / `custom`) are reported separately — `workshop-sponsor.js` `aggregate()` returns `added: { scored, qualitative }`, and `workshop-room.html` renders a "Your added questions" card (scored add-ons with the 4.0 band colors; open-ended shown as response COUNTS only, never verbatim, to preserve aggregate confidentiality). This keeps the core benchmarkable across clients.

**NPS — detection fix + context labels.** Detection was `question_id.startsWith('NPS')`, which missed the standard `TP3_NPS_1` (theme `nps`); now matches `question_theme === 'nps'` OR `/NPS/i`. Labels are engagement-aware: assessments show **Employee NPS** (would-recommend-as-a-place-to-work = advocacy, NOT a rating of GPS); workshops show **Session NPS** (recommend the session = delivery).

**Sponsor portal + profile fixes.** `api/get-client.js` now admits sponsors/participants (not just coaching clients), so sponsor links open. Sponsor portal is **dashboard-first**: each workshop card leads with "View Your Dashboard →" (`api/portal-data.js` `my-workshops` returns a server-built `dashboard_url`), roster demoted to "Step 1 — Add your team"; a sponsor with no active workshop gets a warm holding screen, not the lock screen or the coaching wizard. **Blank client profile fixed** — `renderProfileSection` in coach.html referenced `esc()`/`toast()` (trapped in the workshop IIFE) and `industryDatalist` (defined in a different function); added global `esc`/`toast` and a local `industryDatalist`. The coach "Sponsor" filter now keys off `is_sponsor`. add/remove-workshop-sponsor keep `sponsor_client_id` synced and store the title on the junction; a warning surfaces when an added email already belongs to a coaching client/participant.

**Assessment question tooling.** Standard questions are now editable/removable per-assessment in the coach Questions tab (each assessment holds its own copy; the global template bank is untouched). AI-suggested questions: (a) the action now receives the existing approved questions and is told to propose only ADDITIVE, non-duplicative items; (b) new questions are sorted INTO their theme group via a slot map (trust→41, proactivity→81, productivity→121, behavioral→145) so the survey flows, while the fixed closing block (START/STOP/CONTINUE → ADVICE → bottleneck → "if we do NOT improve…", sort 150–210) always stays last; (c) AI drafts now have Edit (not just Approve/Reject). Assessments created via the "+ New assessment" button auto-seed the ~21 standard TP3 questions (the `create-assessment` action) — a raw-SQL-created assessment will NOT have them.

**Infra / cost reality.** **Supabase is on the FREE plan** → no automatic backups (only the manual local zips) and 1 GB storage / bandwidth ceilings that report PDFs will fill. Recommend Supabase Pro (~$25/mo) mainly for backups now that the portal is business-critical. Other free tiers in play: Resend (3k emails/mo), Make.com (1k ops/mo). Paid today: Vercel Pro, Anthropic (usage).

**New env vars this round:** `CLAUDE_MODEL`, `CLAUDE_FAST`, `CLAUDE_REPORT_MODEL` (all optional, default to current models); `COACH_SESSION_SECRET` now also required by `api/testimonial.js`.

**Git handoff reminder (reinforced — this bit Alex today):** run git from INSIDE the repo — `cd "$HOME/Documents/Claude/Projects/Tool Creation"` — commands from `~` fail with "not a git repository." Do NOT use `git add -A` (the folder holds multi-GB zips); add specific files. Migrations are applied to prod directly via the Supabase tool, so a code push only needs the changed `.js`/`.html`/`.json`/migration-record files.

---

## 16. June 6–8, 2026 — PWA, Roles, Nav Refactor, Mobile, Results Fix

**Installable app (PWA).** `manifest.webmanifest` (client, start_url /client), `manifest-sponsor.webmanifest` (/decision-room), `manifest-coach.webmanifest` (/coach), and `sw.js` (minimal no-cache service worker, network-only — never caches pages) make the portal installable. Branded icons in `/icons/`: gps-192.png, gps-512.png, gps-maskable-512.png, gps-apple-touch.png, gps-180.png. A platform-aware "Save to device" card (iOS = guided Share→Add to Home Screen; Android/desktop Chrome = one-tap `beforeinstallprompt`; desktop = QR of current URL) appears in client.html, decision-room.html, coach.html. Coach also has a permanent install card in Settings → Account & Security. Token persistence: client.html/decision-room.html store the `?token=` in localStorage and restore it when the installed app launches without one.

> **CRITICAL RECONSTRUCTION LESSON:** binary image files generated in the AI sandbox do NOT reach the real repo (the mount shows them but `git add` finds nothing and they never deploy). Generate icons locally with macOS `sips` (format-jpeg → resize/pad → format-png yields an alpha-free PNG), or reference them via Google Drive thumbnail URLs (`https://drive.google.com/thumbnail?id=FILEID&sz=wNNN`). The apple-touch-icon MUST have no alpha channel (iOS fills transparency with black; the share-sheet preview misleadingly shows white). Cache-bust icon URLs with `?v=N`.

**Owner/Assistant RBAC (migration v37).** `admin_accounts.role` repurposed to owner|assistant (legacy 'admin' tolerated). The coach session token now carries `lvl`; `api/get-client.js` `coachLogin` sets it (main coach password ⇒ owner; admin_accounts password match ⇒ that row's role). `api/coach-data.js` enforces owner-only server-side: writes to OWNER_ONLY_WRITE tables (email_templates, coach_settings, diagnostic_question_overrides, workshop_questions), deletes of OWNER_ONLY_DELETE tables (clients, diagnostics, teams, workshops, diagnostic_team_reports, raters, responses), plan unlock, and all admin-account actions. UI hides owner-only controls via `body.is-assistant .owner-only{display:none}`. New action `admin-send-password`: owner generates a fresh password for an admin and emails it via Resend (owner never sees it). Anna = the assistant account.

**Coach nav refactor.** Five top groups (Today / Clients / Diagnostics & Teams / Communication / Settings) + Workshops group, with sub-tabs and a global search box. `GROUP_OF` / `GROUP_DEFAULT` / `showGroup()` / rewritten `showSection()`. Today is an action-inbox (needs-attention + this-week + quick stats). Team archive (`teams.archived_at`, migration v36) + team delete; archived teams hidden from coach list and paused for sponsors.

**Mobile pass.** A `@media (max-width:768px)` block in client.html and coach.html eliminates horizontal overflow (min-width:0 on flex children, flex-wrap, max-width caps, scrollable tables, capped heading sizes). Favicons added to all 9 user-facing pages.

**My Results fix (was a real outage).** After v26 the Results tab still used dead anon `db.from()` reads → "No results yet" for every client. Now routed through `api/portal-data.js` action `results-data` (checkins, survey_responses, survey_tokens, self_checks, stakeholders). Added a Consistency card: check-ins submitted (% of weeks), coaching attended %, follow-through %.

**Git handoff note for Alex:** give commands one line at a time (block-paste broke a merge in vi); always `git merge --no-edit`; end with `git status` to confirm clean; his terminal sometimes opens in `~` so include the `cd` line.

---

## 1. What This System Is

The GPS Leadership Portal is the delivery platform for GPS Leadership Solutions, owned and operated by Alex Tremble. It supports two distinct products sold to CEOs and senior leaders at multi-location, operations-heavy businesses ($10M–$100M+ revenue).

**Product A — 90-Day Leadership Coaching Program**
Clients receive a personal portal containing their 90-day leadership action plan. They complete weekly check-ins, track sprint progress, receive stakeholder feedback surveys (TP3™ Scoreboard), and access "Ask Alex" — an AI assistant built on Claude and trained on GPS frameworks. Alex manages all clients from a separate coach dashboard.

**Product B — 14-Day Executive Leadership Diagnostic**
A full 360-style leadership assessment using the TP3™ framework (Trust, Proactivity, Productivity → Profitability). The leader completes a self-assessment, then 10–15 raters (direct reports, peers, supervisors, board members) complete confidential surveys. Claude generates a full narrative report with scored dimensions, behavioral themes, and a 90-day development plan. Pro tier adds succession planning questions and optional 1:1 rater interviews with Alex.

**Strategic intent:** The portal is intentionally a data collection engine. Every interaction is designed to capture leadership behavioral data — challenges surfaced through Ask Alex, rater observations across TP3 dimensions, engagement patterns — to refine the GPS system and inform future products. This is a first-generation AI-augmented coaching platform.

---

## 2. Technology Stack

| Layer | Service | What it does | Alternative if unavailable |
|-------|---------|-------------|---------------------------|
| Hosting | Vercel (Hobby) | Serves HTML files + runs serverless API functions, auto-deploys from GitHub | Netlify, Railway, Render — see Section 8 |
| Database | Supabase (PostgreSQL) | All persistent data: clients, diagnostics, raters, surveys, emails | Any PostgreSQL host — Neon, Railway Postgres, AWS RDS |
| Email | Resend | All transactional email (invites, reminders, reports, portal links) | SendGrid, Postmark |
| AI | Anthropic Claude API (claude-sonnet-4-6) | Ask Alex Q&A + diagnostic report generation | Any LLM with function-calling — GPT-4, Gemini |
| Domain | portal.gpsleadership.org | Custom domain → Vercel | Move DNS CNAME to new host |
| Source control | GitHub (GPSleadership/gps-portal) | All code versioned here | GitLab, Bitbucket, local zip |

**Key architectural choice:** All front-end files are single-file vanilla HTML/CSS/JS with no build step, no framework, no bundler. This is intentional — files open locally without any tooling, can be edited in any text editor, and the entire codebase is readable without a development environment. This trades some developer ergonomics for extreme portability and maintainability by non-engineers.

---

## 3. File Map

### HTML Pages (user-facing)

| File | URL | What it does |
|------|-----|-------------|
| `client.html` | /client | Client portal. Token-gated via `?token=X`. Tabs: My Plan, My Results, My Diagnostic, Ask Alex. Full sprint tracking, check-ins, stakeholder scoreboards, AI assistant. Onboarding wizard v20 with inline goal prefill, edit-mode choice screen, Ask Alex history panel. ~7,000 lines. |
| `coach.html` | /coach | Alex's dashboard. Password-protected. Tabs: Dashboard, Clients, Diagnostics, Team Reports, Email Log. Add-client modal includes inline diagnostic setup. Report tab includes PDF upload card. ~6,400 lines. |
| `diagnostic-survey.html` | /diagnostic-survey | Rater survey. Token-gated. TP3 V2 question bank (35 questions), section progress bar, self vs rater branching, mobile-optimized. Hard-blocks on closed surveys. |
| `survey.html` | /survey | Stakeholder feedback survey for the 90-day coaching program. Separate from the diagnostic system. |
| `diagnostic-leader.html` | /diagnostic-leader | Leader intake portal for the diagnostic. Self-assessment form, rater list submission, unlock sequence. Expanded rater relationship types (8 options + Other write-in). |
| `diagnostic-sandbox.html` | /diagnostic-sandbox | Clickable prototype / design reference. Not production. |
| `diagnostic-coach.html` | /diagnostic-coach | Legacy coach diagnostic view. Superseded by coach.html Diagnostics tab. |
| `client-DEMO.html` | — | Demo version of client portal. No live data. For sales/preview use. |
| `gps-executive-console.html` | — | Executive console UI (in development). |

### API Functions (`/api/` — Vercel serverless, Node.js)

| File | Trigger | What it does |
|------|---------|-------------|
| `diagnostic.js` | POST `?action=` | Master diagnostic handler. 6 routes via action param: `send-invites`, `generate-question` (G1), `generate-report`, `generate-team-report`, `finalize-report`, `reminders`. 60s maxDuration. ~1,650 lines. |
| `ask.js` | POST | Ask Alex endpoint. Calls Anthropic API. Logs full Q+R to `ask_alex_log`. Also handles `action=prefill` — takes a 90-day goal and returns AI-suggested behaviors, metrics, and 30-day goal (uses claude-haiku-4-5 for speed). 60s maxDuration. |
| `get-client.js` | GET / POST | Client auth: GET `?token=X` returns client record + diagnostic_prefill data. POST `{email}` sends portal link recovery email. |
| `notify.js` | POST | Email notification hub for coaching program: check-in alerts, plan submissions, stakeholder responses, welcome emails, portal_welcome (post-diagnostic debrief email with portal link — sent by markDebriefComplete when a coaching client is linked). |
| `send-reminders.js` | Cron (Mon 2pm UTC) | Weekly coaching reminders: check-in nudges, auto-archive after 45 days inactive. |
| `survey-reminders.js` | Cron (daily 2pm UTC) | Daily stakeholder survey nudges, auto-confirm logic, welcome email sequence. |
| `survey.js` | GET / POST | Stakeholder survey load + submission handler. |
| `accept-terms.js` | POST | Records AI terms acceptance timestamp. |
| `start-sprint.js` | POST | Starts a new 13-week sprint for a client. |
| `submit-closeout.js` | POST | Handles 90-day plan closeout submission. |
| `import-clients.js` | POST | Bulk client import from CSV. |
| `email-templates.js` | GET | Returns email template previews for coach review. |

> **Critical:** Vercel Hobby plan caps at 12 serverless functions. This project is at exactly 12. All diagnostic operations share one file via `?action=` routing. Adding any new API file requires upgrading to Vercel Pro or merging into an existing file.

### Database Migrations (run in order v2 → v25; no v21 file exists)

| File | What it adds |
|------|-------------|
| `supabase-setup.sql` | Initial schema: clients, sprints, checkins, stakeholders, survey_tokens, survey_responses |
| `supabase-migration-v2.sql` | email_log, admin_accounts, checkin_drafts |
| `supabase-migration-v3.sql` | stakeholders, survey_responses, survey_tokens |
| `supabase-migration-v4.sql` | Full schema rewrite with sprint system |
| `supabase-migration-v5.sql` | confirmed_at on stakeholders |
| `supabase-migration-v6.sql` | sprint_number on checkins |
| `supabase-migration-v7.sql` | last_active_at on clients (45-day auto-archive) |
| `supabase-migration-v8.sql` | portal_first_active_at on clients (90-day access window) |
| `supabase-migration-v9.sql` | continuation_step for post-expiry email sequence |
| `supabase-migration-v10.sql` | welcome_reminder_step for onboarding emails |
| `supabase-migration-v11.sql` | preferred_name, title, org on clients; coach_profile table |
| `supabase-migration-v12.sql` | Diagnostic-related client fields |
| `supabase-migration-v13.sql` | diagnostics, diagnostic_raters, diagnostic_report_drafts, diagnostic_question_overrides, diagnostic_team_reports |
| `supabase-migration-v14.sql` | RLS policies, indexes, email_log diagnostic columns |
| `supabase-migration-v15.sql` | alert_t2_sent_at, survey_closed_at on diagnostics |
| `supabase-migration-v16.sql` | Debrief fields, plan fields, coaching_notes, interview_notes |
| `supabase-migration-v17.sql` | is_archived (BOOLEAN), all_raters_complete_at (TIMESTAMPTZ) on diagnostics |
| `supabase-migration-v18.sql` | ask_alex_log table: full Q+R text capture (question_text, response_text, sprint_number, token counts) |
| `supabase-migration-v19.sql` | interviews_enabled, interview_calendar_link, interview_max_count on diagnostics; will_interview on diagnostic_raters |
| `supabase-migration-v20.sql` | **clients:** metric_2_question (TEXT), metric_2_target_avg (FLOAT DEFAULT 4.0) for new Metric 2 model. **diagnostics:** wizard_prefill_data (JSONB) for onboarding prefill content. Required before deploying wizard v20. |
| `supabase-migration-v22.sql` | **Testimonial & Referral Flywheel.** **clients:** engagement_type (TEXT, 'diagnostic_only' \| 'diagnostic_plus_coaching'), first_big_win_flag (BOOLEAN), debrief/midpoint/endof testimonial_prompted_at (TIMESTAMPTZ). New tables: **testimonials** (id, client_id, engagement_type, source, responses JSONB, rating_nps, permission_public_use) and **referrals** (id, referrer_client_id, referral_name/email/org, engagement_type_suggested, email_subject/body, status, sent_at). Seeded referral config into gps_settings. |
| `supabase-migration-v23.sql` | **diagnostics:** report_pdf_url (TEXT) — public URL of uploaded PDF in Supabase Storage. Creates `diagnostic-reports` storage bucket (public: true) with anon INSERT/UPDATE + public SELECT policies. |
| `supabase-migration-v24.sql` | **diagnostics:** debrief_date (DATE), report_release_at (TIMESTAMPTZ). report_release_at is computed as 22:00 UTC the day before debrief_date (= COB Eastern). Set by coach portal when debrief_date is saved. Leader sees report automatically once this timestamp passes. |
| `supabase-migration-v25.sql` | **diagnostics:** coaching_portal_url (TEXT). Set by coach portal when markDebriefComplete() runs (if a coaching client is linked). Read by diagnostic-leader.html to show "Go to Your Coaching Portal" button in Step 8. |

### Config

| File | What it does |
|------|-------------|
| `vercel.json` | URL rewrites (clean paths), cron schedules, CORS headers, function maxDuration timeouts |
| `.env.example` | Template of all required environment variables (no real values) |
| `SETUP-GUIDE.md` | Step-by-step setup instructions for new deployment |
| `GPS_PORTAL_SURVIVAL_PACKAGE.md` | This document |

### Scripts (not deployed — run locally)

| File | What it does |
|------|-------------|
| `check.sh` | Pre-push validation: JS syntax check on all HTML files, backslash-backtick hazard scan (per-file baseline: coach.html=0, client.html=0 — any `\`` in either file fails), vercel.json/vercelignore consistency check, serverless function count. Run automatically via git hook — do not bypass. |
| `deploy.sh` | Safe deploy wrapper: runs check.sh, then stages all changes, commits with your message, and pushes. Usage: `./deploy.sh "commit message"` |
| `smoke-test.sh` | Post-deploy health check: hits /coach, /client, and key API endpoints on the live portal. Run 90 seconds after a push. |
| `install-hooks.sh` | One-time setup: installs the git pre-push hook so check.sh runs automatically on every `git push`. Must be re-run after cloning on a new machine. |
| `scripts/export-backup.js` | Exports Supabase data to local JSON for backup |
| `scripts/cleanup-test-profiles.js` | Removes test client records from DB |

---

## 4. Environment Variables

All set in Vercel → Project Settings → Environment Variables. Never in code.

| Variable | Required | What it does | Where to get it |
|----------|----------|-------------|----------------|
| `SUPABASE_URL` | ✅ | Supabase project REST API URL | Supabase dashboard → Project Settings → API |
| `SUPABASE_ANON` | ✅ | Supabase anon/public key (safe for browser JS) | Same location |
| `SUPABASE_SECRET_KEY` | ✅ | Supabase service role key (server-side only — never expose) | Same location |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key — required for Ask Alex and report generation | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | ✅ | Resend email API key | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | ✅ | Sender name + address, e.g. `Alex Tremble – GPS Leadership <alex@gpsleadership.org>` | Set manually to match verified domain |
| `PORTAL_BASE_URL` | ✅ | Root URL, e.g. `https://portal.gpsleadership.org` | Your domain |
| `SITE_URL` | ✅ | Same as PORTAL_BASE_URL (used in email links) | Your domain |
| `COACH_ALERT_EMAIL` | ✅ | Where system alerts go (bounce spikes, all-raters-complete, etc.) | alex@gpsleadership.org |
| `CRON_SECRET` | ✅ | Authenticates manual cron triggers via Authorization header | Generate: `openssl rand -hex 32` |

---

## 5. Step-by-Step Setup Guide (Zero to Live)

### Step 1: Supabase
1. Create account at supabase.com
2. Create new project (choose a region close to your users)
3. Go to SQL Editor
4. Run migrations in order: `supabase-setup.sql`, then `v2.sql` through `v19.sql`
5. Go to Project Settings → API → copy Project URL and both keys (anon + service_role)
6. Verify RLS is enabled: in the Table Editor, confirm the lock icon appears on all tables

### Step 2: Resend
1. Create account at resend.com
2. Add domain: gpsleadership.org
3. Add DNS records shown by Resend (DKIM + SPF + DMARC) at your domain registrar
4. Wait for verification (usually minutes, can take up to 24 hours)
5. Create API key with "Send" permission
6. Test with a manual send before going live

### Step 3: Anthropic
1. Create account at console.anthropic.com
2. Add payment method (pay-as-you-go)
3. Create API key
4. Model used: `claude-sonnet-4-6` — verify this model is still available at time of setup
5. Budget alert recommended: set a monthly spend alert in billing settings

### Step 4: GitHub
1. Create organization: GPSleadership (or personal repo)
2. Push all files: `git init`, `git add .`, `git commit -m "Initial"`, `git push`
3. Confirm `.env` is in `.gitignore` — never commit real secrets

### Step 5: Vercel
1. Create account at vercel.com
2. Import GitHub repo (Connect to Git → select GPSleadership/gps-portal)
3. Framework preset: **Other** (not Next.js — this is vanilla HTML)
4. Add all 10 environment variables from Section 4
5. Deploy — Vercel auto-detects the `api/` folder and deploys each `.js` file as a serverless function
6. Add custom domain: portal.gpsleadership.org
7. Update DNS at registrar: add CNAME → `cname.vercel-dns.com`
8. Wait for SSL certificate (usually < 5 minutes)

### Step 6: Verify cron jobs
1. Go to Vercel → Project → Cron Jobs
2. Confirm three jobs appear (send-reminders, survey-reminders, diagnostic reminders)
3. Test manually: POST to `/api/send-reminders` with `Authorization: Bearer [CRON_SECRET]` and body `{"manual_trigger": true}`

### Step 7: Create coach login
Run in Supabase SQL Editor:
```sql
INSERT INTO admin_accounts (name, email, password, role)
VALUES ('Alex Tremble', 'alex@gpsleadership.org', 'YOUR_PASSWORD_HERE', 'admin');
```

### Step 8: Smoke test
1. Open `https://portal.gpsleadership.org/coach` → confirm login works
2. Create a test client → verify portal link generates
3. Open the portal link → confirm client portal loads
4. Test Ask Alex → confirm response (requires ANTHROPIC_API_KEY)
5. Create a test diagnostic → send a test invite → confirm email arrives

---

## 6. Architecture Decisions & Why

**Single-file HTML pages (no React/Vue/framework)**
No build step, no npm, no dependency vulnerabilities. Files open locally in any browser with no setup. Alex or any future developer can read the entire codebase without a development environment. The tradeoff is large files (coach.html is ~6,200 lines) but this is manageable. If files grow past ~10,000 lines, consider splitting into modular JS includes.

**Supabase directly from browser (no backend middleware)** — ⚠️ **SUPERSEDED June 3, 2026. This is no longer true. See Section 13.**
*(Historical:* the browser used the anon key + RLS to read its own data.*)* **Current model:** the browser does **not** query Supabase directly. All data flows through token/session-validated serverless endpoints (`api/portal-data.js`, `api/coach-data.js`, `api/diag-portal.js`, `api/get-client.js`) that use the service-role key and scope every query in code. All tables are RLS **deny-all to anon** (the service role bypasses RLS). **Access control lives in the endpoint, not in RLS.** Any new feature must follow this pattern — never reintroduce `db.from(...)` with the anon key in a page.

**`?action=` routing in api/diagnostic.js**
Vercel Hobby caps at 12 serverless functions. This project is at the cap. All 6 diagnostic operations (send invites, generate question, generate report, generate team report, finalize report, reminders) live in one file routed by query param. This is a hard architectural constraint. Moving to Vercel Pro removes this limit.

**Report stored as JSON + pre-rendered HTML narrative**
Claude generates the report once. The `content_json` field stores the full structured report (scored dimensions, themes, recommendations) plus a `full_narrative` key containing pre-rendered HTML. The portal renders the HTML directly — no re-processing required. This trades storage space for zero latency on report display.

**localStorage for rate limiting (G1)**
The custom rater question (G1) generation is capped at 3 attempts per diagnostic. Client-side localStorage tracks the count; server-side enforces a 30-second debounce. Combined gate prevents runaway API usage without a separate rate-limit table.

**ask_alex_log for data strategy**
The original `ask_alex_usage` table only captured question length (a counter). `ask_alex_log` (v18) captures full question text, response text, sprint context, and token counts. Both tables coexist: usage for UI stats, log for future model training and product development. This is a deliberate data strategy — the portal is designed to accumulate proprietary training data over time.

**Interview feature (v19) — per-diagnostic flag, not tier-based**
Interview access is controlled per-diagnostic via `interviews_enabled` toggle rather than being locked to Pro tier. This is because standard-tier clients sometimes receive interviews as a goodwill gesture. A tier-based gate would require override logic; a per-diagnostic flag is simpler and more flexible.

---

## 7. Key Data Model

```
clients
  id (UUID), name, email, org, title, preferred_name
  token                       — portal login key, unique per client
  portal_first_active_at      — when they first opened the portal
  last_active_at              — updated on every portal load
  is_active, is_archived      — lifecycle flags
  current_sprint_number       — which 13-week sprint they're in
  plan_submitted_at           — when they first submitted their action plan
  coaching_sessions_enabled   — shows attendance question in check-ins
  ask_alex_enabled            — shows/hides Ask Alex tab
  ask_alex_total_questions    — counter (incremented via RPC)
  ask_alex_last_used_at
  industry, revenue_band, num_locations  — for AI context
  engagement_type             — 'diagnostic_only' | 'diagnostic_plus_coaching' (v22)
  first_big_win_flag          — coach toggles TRUE at first significant win; triggers midpoint testimonial prompt (v22)
  debrief_testimonial_prompted_at, midpoint_testimonial_prompted_at, endof_testimonial_prompted_at  — dedup guards (v22)
  coaching_program_start_date, coaching_program_end_date
  diagnostic_report_url       — Google Drive link to their report
  portal_locked               — locks portal access

diagnostics
  id (UUID), client_id (→clients), client_name, client_email, client_title, client_org
  leader_token                — leader's portal access
  status                      — pipeline: setup → intake_complete → self_assessment_pending
                                → self_assessment_complete → survey_open → survey_closed
                                → report_draft → report_final → debrief_complete → plan_active
  tier (standard | pro)
  email_delivery_mode (gps_sends | client_sends)
  is_archived                 — hides from default coach view
  all_raters_complete_at      — stamped when 7+ raters complete
  interviews_enabled          — per-diagnostic interview flag (v19)
  interview_calendar_link     — GHL calendar URL for interview-tagged raters
  interview_max_count         — cap on interview slots
  custom_g1_question          — AI-generated custom rater question
  custom_g1_generated_at      — timestamp for server-side debounce
  [self-report fields]        — self_strengths, self_blind_spots, self_leadership_style,
                                self_three_year_vision, self_successor_candidates...
  intake_notes, coaching_notes, interview_notes
  invites_sent_at, survey_closed_at, report_finalized_at, debrief_completed_at
  close_date, start_date
  debrief_date                — date of scheduled debrief session (v24)
  report_release_at           — 22:00 UTC day before debrief_date; leader portal shows report after this (v24)
  report_pdf_url              — public Supabase Storage URL of uploaded PDF report (v23)
  coaching_portal_url         — coaching client's portal URL; set on debrief complete; shows button in leader Step 8 (v25)

diagnostic_raters
  id, diagnostic_id (→diagnostics), name, email
  token                       — survey access key
  is_self                     — TRUE for leader's own self-assessment row
  role, relationship          — e.g. "Direct Report", "Peer"
  invited_at, completed_at
  reminder_1_sent_at, reminder_2_sent_at
  email_bounced               — flagged by bounce webhook
  will_interview              — TRUE = gets calendar link in invite email (v19)

diagnostic_report_drafts
  id, diagnostic_id, version (1,2,3...)
  content_json                — full report: scored dimensions + full_narrative (pre-rendered HTML)
                                OR { report_type: 'pdf_upload', pdf_base64: 'data:application/pdf;base64,...' }
                                for manually uploaded final reports (base64-encoded, max ~8MB)
  generated_at, model_used, input_tokens, output_tokens

testimonials  (v22 — post-engagement social proof capture)
  id, client_id, engagement_type, source (diagnostic_debrief | coaching_midpoint | engagement_end)
  responses (JSONB — question text → answer text map), rating_nps (0–10)
  permission_public_use (BOOLEAN — coach toggles when client approves public use)

referrals  (v22 — referral tracking)
  id, referrer_client_id, referral_name, referral_email, referral_org
  engagement_type_suggested, email_subject, email_body (pre-generated mailto body)
  status: draft_email_created → sent → responded → converted
  sent_at, created_at

diagnostic-reports  (Supabase Storage bucket, v23)
  Public bucket. Files uploaded by coach as PDF reports.
  Anon INSERT/UPDATE allowed (secured at app level by coach password). Public SELECT for client iframe view.
  URL stored in diagnostics.report_pdf_url.

ask_alex_log  (v18 — full text capture)
  id, client_id, asked_at
  question_text, response_text
  sprint_number, input_tokens, output_tokens

ask_alex_usage  (legacy counter — kept for backward compat)
  id, client_id, asked_at, question_length

email_log
  id, sent_at, recipient_email, email_type, status (sent/error), error_details, resend_id

clients → checkins            — weekly check-in submissions
clients → sprint_closeouts    — 90-day closeout forms
clients → stakeholders → survey_tokens → survey_responses  — stakeholder feedback loop
```

---

## 8. Platform Migration Guide

### If Vercel goes away
1. Wrap all `api/*.js` files in Express routes: `app.post('/api/endpoint', handler)` — the function signature changes from `export default function handler(req, res)` to a standard Express handler
2. Host HTML files as static assets (any CDN or S3)
3. Set up cron jobs via the new platform's scheduler or a service like Upstash
4. The 12-function limit was a Vercel Hobby constraint — no equivalent limit on other platforms

### If Supabase goes away
1. Spin up PostgreSQL on Neon, Railway, AWS RDS, or any Postgres host
2. Run all migrations v2–v25 in order against the new database (skip v21 — no file exists)
3. Supabase exposes PostgREST — replace `fetch` calls in API files with a `pg` or `postgres` Node client
4. Update `SUPABASE_URL` and both keys in environment variables
5. The browser-side Supabase JS client (`createClient`) would need to be replaced with direct API calls or a different client library

### If Resend goes away
1. Replace `sendEmail()` calls in `api/notify.js` and `api/diagnostic.js` with the new provider's API
2. The email HTML templates are self-contained strings in the code — they don't need to change
3. Verify DKIM/SPF/DMARC records for gpsleadership.org on the new provider
4. Update `RESEND_API_KEY` and `RESEND_FROM_EMAIL` environment variables

### If Anthropic Claude API goes away
1. Replace the Anthropic API call in `api/ask.js` and `api/diagnostic.js` with the new LLM's API
2. The system prompts are self-contained strings in the code — the logic doesn't change, only the API call shape
3. Update `ANTHROPIC_API_KEY` to the new provider's key
4. Report generation context window requirements: the diagnostic report prompt is large. The replacement model needs at least 32K context and strong instruction-following for the structured JSON output format.

### Estimated migration time (competent developer)
- Vercel → Railway/Render: ~4 hours
- Supabase → any Postgres: ~8 hours (mostly testing RLS equivalents)
- Resend → SendGrid: ~2 hours
- Anthropic → other LLM: ~4 hours (prompt tuning for new model)

---

## 9. Feature Log (What Was Built & When)

### Foundation (2024–early 2025)
- Client portal (client.html) with token-gated login, plan display, weekly check-ins
- Coach dashboard (coach.html) with client management
- Email system (notify.js, send-reminders.js) for weekly coaching reminders
- Supabase schema: clients, checkins, sprints, stakeholders, survey system
- Ask Alex AI assistant with GPS system prompt
- Sprint system: 13-week sprints, start-next-sprint flow, 90-day closeouts
- Portal access window (90-day timer from first active)
- Welcome email sequence

### Coach portal redesign (2025)
- Full-screen client profiles replacing modal approach
- User menu, profile modal, preferred name
- Meet Your Coach card in client portal
- Coach profile management

### Diagnostic system — Phase 5 (early 2026)
- Full diagnostic pipeline: 9-milestone status flow
- diagnostic-survey.html: TP3 V2 question bank, 35 questions across 5 dimensions
- diagnostic-leader.html: self-assessment + rater list submission
- api/diagnostic.js: all 6 actions in one file
- AI report generation (Claude): full narrative + scored dimensions
- Team reports across multiple diagnostic clients
- GHL export field mapping

### P2 Improvements (May 2026)

**Tier 1 — Rater management**
- Bounce badge on rater rows + inline email correction
- Zero-response warning when closing survey early

**Tier 2 — Diagnostic management**
- Archive/unarchive diagnostics (hidden from default view)
- All-raters-complete email alert when 7+ raters finish (threshold = minimum for valid report)
- CSV + Excel export of diagnostic response data

**Tier 3 — Safety & polish**
- G1 rate limit: 3 attempts per diagnostic (localStorage + 30s server debounce)
- Survey token hard-block: re-verifies status at submit time
- Mobile optimization: 44px touch targets, stacked nav, compressed layout

**Ask Alex Logger (May 28, 2026)**
- ask_alex_log table (v18): full question + response text, sprint context, token counts
- api/ask.js updated: captures all content on every interaction
- Coach dashboard: per-client question history with collapsible responses

**Interview Feature (May 28, 2026)**
- Per-diagnostic interview toggle (not tier-gated — enables goodwill interviews on standard tier)
- Calendar link field + max interview slot cap
- Checkbox per rater row to mark for interview (enforces cap)
- Interview-tagged raters receive calendar booking section in their invite email

**May 31, 2026 — Testimonial & Referral Flywheel (v22)**

- New `testimonials` table: captures structured post-engagement feedback (responses JSONB, NPS rating, public permission flag). Three trigger points: diagnostic_debrief, coaching_midpoint, engagement_end.
- New `referrals` table: tracks client referrals with pre-generated mailto email body. Status pipeline: draft_email_created → sent → responded → converted.
- `clients` gets: engagement_type ('diagnostic_only' | 'diagnostic_plus_coaching'), first_big_win_flag (coach toggles at meaningful milestone to trigger midpoint prompt), and three testimonial_prompted_at timestamps (dedup guards).
- Coach dashboard: testimonial view with per-client form — question list, response capture, NPS score, public permission toggle. Referral generation panel.

**June 2, 2026 — Coach Dashboard & Onboarding Session**

*Coach dashboard improvements (coach.html):*
- Add Client modal: removed "Regions Owned" field (never used). Renamed "Client has weekly coaching sessions" → "Coaching Client" throughout (modal, profile view, toggle buttons). Added "Setting Up for Diagnostic" checkbox — when checked, Tier and Email Delivery selectors appear inline; after the client is saved, a diagnostic is created automatically and linked. No need to go to the Diagnostics tab separately.
- Report tab: "Upload Final Report" card (static HTML outside JS template literals — avoids V8 parse error pattern). Accepts PDF up to 8MB. Uploads to Supabase Storage bucket `diagnostic-reports`, stores public URL in `diagnostics.report_pdf_url`, marks diagnostic as `report_final`. Client portal (diagnostic-leader.html) detects `report_pdf_url` and renders the PDF in an iframe with a download button. **Note:** An earlier attempt stored base64 in `diagnostic_report_drafts.content_json` — this was reverted because it caused a JS parse error in a template literal. Current approach (Storage + URL) is the correct one.
- 90-day plan section removed from Report tab (was unused).

*Diagnostic rater relationship types (diagnostic-leader.html + coach.html):*
- Expanded from 7 options to 8: Direct Report, Peer, Supervisor / Manager, Board Member, Internal Customer, External Customer, External Stakeholder, Other
- "Other" triggers a write-in text field; saves as "Other: [text]"
- Definition strip added below each dropdown so every type is explained

*Onboarding wizard improvements (client.html):*
- Stakeholder step: updated hint text to include definitions for all relationship types
- Goal step (wizS2): inline AI prefill fires 1.2 seconds after user pauses typing their 90-day goal (≥ 8 words). Calls `/api/ask` with `action: 'prefill'`. Suggestions arrive as: 30-day goal (filled directly in the DOM while still on Step 2), behavior 1, behavior 2, metric 1 name, metric 2 question — all stored in `wizPlan` for later steps. Responses use first-person "I" framing enforced in the prompt. A teal notice banner explains the feature at the top of the Goals card; it fades out when suggestions land. Does NOT fire if diagnostic prefill is already present.
- Edit mode: replaced "All fields start blank / Update anything that needs to change" with a "Keep my answers / Start fresh" choice screen. "Keep my answers" (default) pre-fills wizard from existing client data. "Start fresh" clears all fields. Choice cards update live with teal/red border on selection.
- Ask Alex tab: "Recent Questions" panel loads last 7 Q&A pairs from `ask_alex_log` on every tab open. Each entry shows the question collapsed; click to expand the full answer. "Copy answer" button on each expanded entry. Panel auto-refreshes 800ms after every new Ask Alex response.

*api/ask.js:*
- Added `action: 'prefill'` route. Input: `{ goal90, goal30, pillar }`. Returns JSON: `{ prefill: { behavior1, behavior2, metric1Name, metric2Question, goal30 } }`. Uses `claude-haiku-4-5-20251001` (fast, cheap) instead of Sonnet. Does not log to `ask_alex_log`.

*check.sh:*
- Backtick scan upgraded from "fail on any `\``" to per-file baseline. coach.html baseline = 2 (pre-existing valid escaped backticks in an IIFE inside a template literal). Only fails if new occurrences are added above that count.

*Incident: SVG in template literal broke coach.html login (June 2, 2026):*
- First attempt at PDF upload embedded an SVG icon inline inside `rpt.innerHTML = \`...\``. The SVG path data caused V8 to fail parsing the template literal. Login stopped responding.
- Fix: moved all upload UI to static HTML in the page body (outside all JS template literals). JS functions use only plain strings. Zero special characters in JS code. This is the correct pattern for this codebase — never embed SVG or binary-like content inside JS template literals.
- **Rule:** All SVG, complex HTML, or content with special characters goes in the static HTML section of the file, shown/hidden via `style.display`. Never generate it inside a JS template literal.

**June 2, 2026 (evening) — Debrief Date, Auto-Release & Portal Welcome**

*Debrief date + auto-release (v24, coach.html, diagnostic-leader.html):*
- Coach can set a debrief_date on each diagnostic. When saved, report_release_at is computed as 22:00 UTC the day before (= COB Eastern time — ~6pm EDT / 5pm EST). Stored in diagnostics.
- diagnostic-leader.html checks report_release_at on load. Once the timestamp passes, the leader's portal automatically shows their report without the coach needing to manually release it.
- Coach dashboard shows the release date/time below the debrief date input.

*Portal welcome email (v25, api/notify.js):*
- New email type `portal_welcome`. Sent automatically inside `markDebriefComplete()` in coach.html when a coaching client is linked to the diagnostic.
- Content: post-debrief context, portal access button, 3-step "what to do first" instructions, weekly rhythm explanation. FROM: Alex's direct email. Plain instructions, no hype.
- `diagnostics.coaching_portal_url` (v25) stores the linked client's portal URL — set at debrief-complete time so diagnostic-leader.html can access it without a separate clients table lookup.

*Coaching portal button on leader page (diagnostic-leader.html):*
- In Step 8 (post-survey completion), if `DIAGNOSTIC.coaching_portal_url` is set, a "Go to Your Coaching Portal →" button appears. Otherwise the field is blank.

*check.sh baseline update:*
- coach.html backtick baseline lowered from 2 → 0. The two pre-existing escaped backticks in an IIFE were cleaned up, so the baseline is now zero. Any `\`` in coach.html now fails the check immediately.

**Deployment Safety System (May 29, 2026)**

Root cause incident: Coach portal login was completely non-functional for the duration of a live coaching session. Two independent bugs compounded each other.

Bug 1 — JS parse error (coach.html, line 4807): A `\`` (backslash-backtick) inside a `${}` expression within a template literal was a real JavaScript syntax error. In expression context, `\`` is not a valid template literal delimiter — only a plain backtick works there. The error caused the entire 4,800-line script block to fail at parse time. Because JavaScript parse errors on a script block don't always surface in the browser console, the button did nothing with zero visible feedback. The fix: replace with string concatenation.

Bug 2 — Vercel build failure (vercel.json): `api/import-clients.js` was listed in the `functions` config in `vercel.json` but excluded by `.vercelignore`. Vercel validates function config before deploying and fails the entire build if a listed file is excluded or missing. The build was failing in 1 second, meaning no new code had been deployed from any commit for the preceding days. The fix: remove the excluded file from `vercel.json` functions.

Resolution: added `check.sh`, `deploy.sh`, `smoke-test.sh`, and `install-hooks.sh` to catch both classes of error automatically on every git push. See Section 10 for full documentation.

---

## 10. Deployment Safety System

**Why this exists:** On May 29, 2026, a `\`` (backslash-backtick) syntax error in coach.html caused the entire JavaScript block to fail silently. The login button did nothing. There were no browser console errors. Simultaneously, `vercel.json` referenced `api/import-clients.js` in its `functions` config while `.vercelignore` excluded that same file — causing every Vercel build to fail at the config validation step before any code was deployed. Both errors were undetectable without tooling. The portal was down for the duration of a live coaching session.

These scripts exist to catch both classes of error before any code reaches Vercel.

---

### The Four Scripts

**`check.sh` — Pre-push validator**

Runs five checks in sequence:

1. **JavaScript syntax** — Extracts all inline `<script>` blocks from every HTML file and runs `node --check` against them. Catches parse errors that browsers report silently or not at all.

2. **Backslash-backtick scan** — Searches for literal `\`` characters in coach.html and client.html. Inside a `${}` expression in a template literal, `\`` is a syntax error (valid only inside a string literal, not as a template literal delimiter in expression context). This is the specific bug that broke login on May 29, 2026. **Current baselines: coach.html=0, client.html=0.** Any `\`` in either file fails the check immediately.

3. **vercel.json / .vercelignore consistency** — Verifies that every file listed in the `functions` section of `vercel.json` (a) actually exists on disk and (b) is not excluded by `.vercelignore`. A mismatch causes Vercel to fail the entire build in ~1 second before deploying anything.

4. **Serverless function count** — Counts deployed `api/*.js` files (minus `.vercelignore` exclusions) against the Vercel Hobby plan limit of 12. Warns at 11, fails at 13+.

5. **Untracked file warning** — Flags any `.html`, `.js`, `.json`, or `.sh` files that exist locally but aren't staged. Prevents silently shipping without recently added files.

**`deploy.sh` — Safe deploy wrapper**

Replaces bare `git push origin main`. Usage: `./deploy.sh "your commit message"`. Runs check.sh first; only commits and pushes if all checks pass. If checks fail, push is blocked and the specific error is displayed.

**`install-hooks.sh` — One-time git hook installer**

Installs a git pre-push hook in `.git/hooks/pre-push` that calls check.sh automatically. After running this once, every `git push` — regardless of how it's issued — triggers the check. The hook is stored in `.git/` which is not tracked by git, so this must be re-run after cloning on a new machine.

**`smoke-test.sh` — Post-deploy health check**

Run 90 seconds after a push to confirm the live portal is healthy. Checks:
- `/coach` returns HTTP 200 and contains the login screen
- `/client` returns HTTP 200 and contains GPS branding
- Live page does NOT contain backslash-backtick hazards (confirms new code is serving)
- `/api/get-client` and `/api/diagnostic` return expected responses (not 500)
- Supabase JS CDN is reachable

---

### Setup on a New Machine (or After Cloning)

```bash
cd "/path/to/gps-portal"
chmod +x check.sh deploy.sh smoke-test.sh install-hooks.sh
./install-hooks.sh
```

That's it. The pre-push hook is now active. Every `git push` runs the check automatically.

**Dependency:** `check.sh` requires Node.js for JS syntax checking. The script auto-detects Node at common Mac install locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm/`). If Node is not found, syntax checking is skipped with a warning — the other four checks still run. Install Node from nodejs.org if you want full validation.

---

### Adapting These Scripts to a New Platform

The checks in `check.sh` are platform-agnostic — they validate local files before they leave your machine, not anything specific to Vercel. When migrating:

- The **JS syntax check** and **backslash-backtick scan** apply on any platform.
- The **vercel.json check** needs to be adapted to the new platform's config file. The principle is the same: any file referenced in deployment config must exist and not be excluded.
- The **function count check** is Vercel Hobby-specific. Remove or adjust the limit for other platforms.
- The **smoke-test URLs** only need the base URL updated (`BASE="https://your-new-domain.com"`).

---

## 11. Cron Schedule

All times UTC. Vercel runs these automatically.

| Job | Cron | File | What it does |
|-----|------|------|-------------|
| Coaching reminders | `0 14 * * 1` (Mon 2pm UTC) | send-reminders.js | Check-in nudges, 45-day auto-archive |
| Survey reminders | `0 14 * * *` (daily 2pm UTC) | survey-reminders.js | Stakeholder survey nudges, auto-confirm, welcome sequence |
| Diagnostic reminders | `0 14 * * *` (daily 2pm UTC) | diagnostic.js?action=reminders | R1/R2 rater reminders, T-2 alerts, all-complete alert, plan auto-lock, email health check |

**Manual trigger:** POST with `Authorization: Bearer [CRON_SECRET]` and body `{"manual_trigger": true}`

---

## 12. Credentials & Account Locations

| Service | Location |
|---------|---------|
| Supabase | supabase.com → GPSleadership organization |
| Vercel | vercel.com → GPS Leadership Solutions team |
| Resend | resend.com → GPS Leadership account |
| Anthropic | console.anthropic.com → GPS Leadership account |
| GitHub | github.com/GPSleadership |
| Domain registrar | Wherever gpsleadership.org DNS is managed |
| GHL (GoHighLevel) | Calendar links for interview scheduling live here |

All API keys and secrets are stored exclusively as Vercel environment variables. They are never in source code or this document.

---

---

## 13. Security Hardening — Phase 1 (June 3, 2026)

A June 3, 2026 premortem (`GPS_Portal_Premortem_2026-06-03.md`) found, and verified against live production, that **every database table had permissive `anon USING(true)` RLS policies** — meaning the public anon key (embedded in the browser HTML) could read and write all client, diagnostic, and rater data, and the coach password was stored/verified in the browser in plaintext. RLS was *enabled* but the policies made it meaningless. This section documents the remediation.

**STATUS: LIVE.** Phase 1 was merged to `main` and the cutover completed in production on **June 3, 2026 (~7:50pm ET)**: `COACH_SESSION_SECRET` set in Vercel, `supabase-migration-v26-lockdown-rls.sql` applied, the two SECURITY DEFINER RPCs revoked from PUBLIC (migration `v26b`), and the coach password rotated via the reset flow. Live smoke test passed. The Supabase security advisor confirms **zero** `rls_policy_always_true` findings; all tables now show "RLS enabled, no policy" (the intended deny-all-to-anon state). The `security-hardening-phase1` branch is merged; keep the `v26` ROLLBACK block available until ~June 10, then it can be deleted.

### The model
The browser no longer talks to Supabase with the anon key for sensitive data. Instead:
- **Client portal** (`client.html`) → all reads/writes go through `/api/portal-data` (token-validated; the server derives the client from the portal token and scopes every operation to that client, with a column allowlist).
- **Coach dashboard** (`coach.html`) → authenticated by a signed **coach session** (see below), data through `/api/coach-data` (hybrid: generic allowlisted proxy for ordinary tables + dedicated hardened actions for `admin_accounts` and settings).
- **Server functions** (`diagnostic.js`, `send-reminders.js`) switched from the anon key to the **service role key**.
- At cutover, **`supabase-migration-v26-lockdown-rls.sql`** drops every permissive anon policy. After it runs, only the service-role key (used by `api/*.js`) can touch the tables.

### New / changed API endpoints
| File | What changed |
|------|-------------|
| `api/get-client.js` | Added coach auth actions: `coach-login` (verifies a **scrypt** password hash server-side, issues a signed HMAC session), `coach-session` (verify), `coach-reset-request` + `coach-reset-complete` (email-gated password reset — code is only ever emailed to `COACH_ALERT_EMAIL`, works even when locked out). |
| `api/portal-data.js` | **NEW.** Token-validated client-portal data endpoint. All client.html reads/writes route here. |
| `api/coach-data.js` | **NEW.** Coach-session-gated dashboard data endpoint (hybrid generic proxy + dedicated admin/settings actions; passwords always hashed). |
| `api/ask.js` | Now **requires a valid portal token**, enforces a server-side daily cap (counts `ask_alex_log`), and restricts CORS to the portal origin. Closes the open free-Claude-proxy hole. |
| `api/send-reminders.js`, `api/survey-reminders.js`, `api/diagnostic.js` | Manual cron trigger no longer accepts the open `{manual_trigger:true}` flag — it now requires `Bearer CRON_SECRET` **or a valid coach session** `{session}`. |

### New files
- `coach-emergency.html` — **break-glass page** at `/coach-emergency`. Minimal, near-unbreakable fallback that uses the same hardened login + the email password reset, and lists clients with portal links. For use when the main dashboard is broken. Bookmark it.
- `api/portal-data.js`, `api/coach-data.js`, `supabase-migration-v26-lockdown-rls.sql`.

### NEW required environment variable
| Variable | Required | What it does |
|----------|----------|-------------|
| `COACH_SESSION_SECRET` | ✅ (at cutover) | HMAC key that signs/verifies coach login sessions and the password-reset codes. Generate: `openssl rand -hex 32`. **Coach login, the emergency page, and the manual cron trigger will not work until this is set in Vercel.** |

The coach password is now stored as a **scrypt hash** in `coach_settings.coach_password_hash` (legacy plaintext `coach_password` is read as a fallback during transition and cleared on first reset). There is no longer a `GPS2026` fallback in working code paths.

### Already shipped (live, before cutover)
- The `diagnostic-reports` storage bucket's broad **listing** policy was removed (migration `harden_diagnostic_reports_remove_listing`) so the confidential PDFs can no longer be enumerated. Full private-bucket + signed-URL hardening is Phase 1 Step 5 (pending).

### Cutover checklist — ✅ COMPLETED June 3, 2026
1. ✅ Merged `security-hardening-phase1` to `main` (rewired app deployed).
2. ✅ Set `COACH_SESSION_SECRET` in Vercel (Production + Preview).
3. ✅ Applied `supabase-migration-v26-lockdown-rls.sql` + `v26b` (RPC EXECUTE revoked from PUBLIC, re-granted to service_role).
4. ✅ Rotated the coach password via `/coach-emergency` → reset.
5. ✅ Live smoke test passed; advisor confirms no `rls_policy_always_true`.

### Still open (non-blocking, deferred from the cutover)
- **Step 5 — full report-bucket privatization** (private bucket + signed URLs). Bucket is already non-listable and the diagnostics table is now locked, so the URL-leak path is closed; full signing is defense-in-depth.
- **Step 7 — `ghl_export_view` → SECURITY INVOKER** (still flagged ERROR by the advisor). Deferred until the view's consumer (likely a GHL/Make export) is confirmed, to avoid breaking an export.
- Minor: four functions have a mutable `search_path` (advisor WARN) — set an explicit `search_path` when convenient.

### Monitoring
A weekly automated **security sweep** runs Fridays 2pm (Claude scheduled task `gps-portal-weekly-security-sweep`): Supabase advisor + RLS drift + repo health + backup freshness; reports only regressions.

---

## 14. Decision Room & Related — Migration Catch-Up (June 4–5, 2026, summary)

The Decision Room shipped after Section 13. Headline state (see `Decision_Room_Integration_Guide.md` + `decision-room.html` + `api/sponsor-data.js` for detail):

| Migration | What it adds |
|-----------|-------------|
| v27 | Decision Room object model: `teams`, `team_members` (joins existing `clients`), `sponsors` (+`sponsor_token`), `sponsor_teams` (per-engagement confidentiality + supervises list), `recommendations`, `external_signals`. RLS enabled, no anon policies. |
| v28 | `survey_responses.scale` — responses carry their own scale (new 1–5 native; legacy backfilled as 10); endpoints normalize per-row, never blind-divide. |
| v29 | Overall-impact question scale move (1–10 → 1–5 going forward; branch on cycle). |
| v30 | `diagnostic_team_reports.team_id` link + sponsor visibility plumbing. |
| v31 | `diagnostic_team_reports.report_pdf_url` — sponsor sees the coach-uploaded branded PDF, never draft text. |
| v32 | `external_feedback_invites` — external feedback request flow. |
| v33 | `clients.coaching_cadence` (weekly/biweekly/monthly) — fixes attendance denominators. |
| v34 | `recommendations` extra fields (target_band, quick-start actions, coach-only GPS-fit tags — stripped from sponsor payload). |

Key pages/endpoints since Section 13: `decision-room.html` (`/decision-room?token=…`), `api/sponsor-data.js` (THE sponsor security boundary — hard feedback gate + private-mode omission), coach.html Decision Room admin (`drAdmin`), `api/testimonial.js`. coach.html nav became grouped (Today / Clients / Diagnostics & Teams / Communication / Workshops & Assessments / Settings).

---

## 15. Workshop & Assessment Module (June 5–6, 2026 — LIVE)

Two products on one engine: **Workshops** (pre + post survey around a delivered session) and **TP3 Organizational Assessments** (one survey wave across an org; no workshop event). Built to the post-v26 model: browser never touches Supabase; endpoints are the gate; RLS deny-all backstop.

### Migrations (all applied to production)
| Migration | What it adds |
|-----------|-------------|
| v35 | `workshops`, `workshop_participants`, `workshop_questions`, `workshop_responses`; **creates `testimonials` + `referrals`** (v22 had never actually been applied to prod — discovered and self-healed here) with nullable `workshop_id`; `clients.is_workshop_participant`; 21 standard TP3 template questions seeded (`workshop_id NULL` = global templates). |
| v36 | `workshops.room_survey_token` — ONE shared in-room/QR survey link per engagement. |
| v38 | `workshops.summary_approved` — the publish gate: sponsor endpoint omits AI narrative + recommendation until TRUE; regenerating sets it FALSE. |
| v39 | `workshops.engagement_kind` ('workshop' \| 'assessment'). |

### Files
- **`api/workshop-data.js`** — coach-session-gated `?action=` hub (mirrors diagnostic.js): upload-roster (one-profile-per-person email matching → `clients`), suggest-questions (AI from `discovery_transcript`), generate-post-questions, aggregate (TP3 indices, per-theme pre/post deltas, NPS = %promoters−%detractors), generate-summary (Sonnet 90-day focus), recommend (rules: trust<3.5→14-Day Diagnostic; weak delegation/proactivity→90-Day CEO Reset; 3+ weak themes→Retreat), send-invites, send-recap, export-participant-csv / export-sponsor-csv / ghl-export, reminders (cron). Sends email via Resend directly. 120s maxDuration.
- **`api/workshop-survey.js`** — token-gated: participant get/save-progress/submit (resume via same token); room-get/room-submit (shared QR; optional email match, else anonymous rows with `participant_id NULL`); sponsor-feedback get/submit (NPS branch: 9–10 → testimonial+consent+bonus+referral, 7–8 → soft, ≤6 → service recovery + `workshops.needs_review`). NPS referent is sponsor-title-aware (CEO/president/owner/founder → "another CEO, president, or owner"; else "a peer or colleague").
- **`api/workshop-sponsor.js`** — sponsor read boundary (mirrors sponsor-data.js). Always returns numbers (participation, NPS, TP3, pre/post theme table, lifecycle timeline — assessment kind gets single-wave labels); withholds strengths/risks/focus90 + recommendation until `summary_approved`. Returns `cta_url` from `coach_settings.workshop_cta_url`.
- **`coach.html`** — nav group **"Workshops & Assessments"** → list (kind/needs-review chips) → tabs Overview / Roster / Questions / Data / Recap. Overview: status, sponsor link, **discovery transcript box**, editable sponsor report (strengths/risks/focus/recommendation) + **"Published to sponsor"** checkbox. Two create buttons (**+ New workshop**, **+ New assessment**) — kind preset, no dropdown; assessment form hides workshop date. Roster: **QR card with Download PNG** (for PowerPoint; phase toggle on workshops, single link on assessments), CSV roster upload, send/per-phase invites. Also: editable "Sponsor 'Schedule a call' link" (writes `coach_settings.workshop_cta_url`). QR lib: qrcodejs from cdnjs.
- **`workshop-room.html`** (`/workshop-room?token=…`) — sponsor dashboard in the **Decision Room design system** (gradient top bar, GPS header, colored TP3 bars with /5.0 + pre→post trend, teal quick-read, green/red strengths/risks columns, Pre→Post-by-theme table, gradient recommendation card with red CTA → booking link). Order: What happened → So what → Now what. Print-clean 1-pager + copy-summary-for-email. Auto-reframes for assessments (3 stat tiles, "Results by theme", assessment timeline).
- **`workshop-survey.html`** (`/workshop-survey?token=…` | `?room=<room_token>&phase=pre|post` | `?token=<sponsor_token>&mode=feedback`) — mobile-first participant survey (progress bar, theme-grouped pages, save & resume), room mode (optional identify), sponsor feedback flow with NPS branching.
- **`workshop-sandbox.html`** — clickable mock prototype (currently behind live).
- `cleanup-workshop-test-data.sql` — removes all `TEST %`/`DEMO %` seed rows FK-safe (real accounts untouched).

### Config / settings / cron
- **No new env vars.** New `coach_settings` key: `workshop_cta_url` (sponsor CTA booking link; default = GHL 30-min discovery call widget). `vercel.json`: rewrites `/workshop-room`, `/workshop-survey`; cron `/api/workshop-data?action=reminders` daily 13:00 UTC (nudges incomplete participants 3 days / 1 day / morning-of survey close).
- `api/coach-data.js` allowlists gained the four workshop tables (coach CRUD via the generic proxy).

### Gotchas / invariants
- One profile per person: participants & sponsors are `clients` rows; roster upload and room-submit match by email before creating; `is_workshop_participant` keeps them out of coaching lists.
- The publish gate is the safe-build rule in code: **no un-reviewed AI narrative reaches a sponsor.**
- Anonymous room responses count toward theme/NPS aggregates but NOT participation % (participation = roster completion).
- Standard templates are `workshop_questions` rows with `workshop_id NULL` — per-workshop questions override; participants fall back to templates when a workshop has none.
- Demo data live as of June 6: 3 `DEMO:` workshops (Ridgeline / Cascade / Summit; Ridgeline's sponsor is real client **Su Nu**) + 1 `TEST` workshop, all `summary_approved=TRUE`.
- Deploys ONLY from `main`. (Incident June 5: commits accumulated on `coach-nav-refactor` while Vercel deployed `main` — nothing shipped until merged. Branch since merged; delete it, and review the old stash holding unexplained `api/get-client.js`/`api/sponsor-data.js` edits.)

### Next major build (specced, not started)
**TP3 Assessment V2** — Organization accounts + logos/branding, expanded 21-question bank with bottleneck/consequence spine, demographics, AI question review flow, XLSX import/export, demo-data generator, AI-drafted recap email, archive/delete. Full spec: `TP3_ASSESSMENT_V2_SPEC.md` (start it with `/gps-portal-safe-build`; Organizations begin at migration **v40**). Note: an untracked `supabase-migration-v37-admin-roles.sql` exists in the folder from another workstream — v37 is taken.

---

*Last updated: June 7, 2026 — Workshop & Assessment Module (v35–v39) deployed to production and documented (Section 15), Decision Room migration catch-up recorded (Section 14). Sponsor narrative is approval-gated; assessments run standalone via `engagement_kind`. Pending hygiene (reminder set for June 10): commit docs, run demo-data cleanup, delete `coach-nav-refactor` + review stash. Next major build: TP3 Assessment V2 (`TP3_ASSESSMENT_V2_SPEC.md`). Update after any session that adds features, changes architecture, or introduces new failure modes.*
