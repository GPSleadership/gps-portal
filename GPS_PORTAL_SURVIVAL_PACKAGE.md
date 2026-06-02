# GPS Leadership Portal — Survival Package
### Everything needed to recreate this system from scratch

**Last updated:** June 2, 2026
**GitHub repo:** https://github.com/GPSleadership/gps-portal
**Live URL:** https://portal.gpsleadership.org
**Coach dashboard:** https://portal.gpsleadership.org/coach
**Client portal:** https://portal.gpsleadership.org/client

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
| `notify.js` | POST | Email notification hub for coaching program: check-in alerts, plan submissions, stakeholder responses, welcome emails. |
| `send-reminders.js` | Cron (Mon 2pm UTC) | Weekly coaching reminders: check-in nudges, auto-archive after 45 days inactive. |
| `survey-reminders.js` | Cron (daily 2pm UTC) | Daily stakeholder survey nudges, auto-confirm logic, welcome email sequence. |
| `survey.js` | GET / POST | Stakeholder survey load + submission handler. |
| `accept-terms.js` | POST | Records AI terms acceptance timestamp. |
| `start-sprint.js` | POST | Starts a new 13-week sprint for a client. |
| `submit-closeout.js` | POST | Handles 90-day plan closeout submission. |
| `import-clients.js` | POST | Bulk client import from CSV. |
| `email-templates.js` | GET | Returns email template previews for coach review. |

> **Critical:** Vercel Hobby plan caps at 12 serverless functions. This project is at exactly 12. All diagnostic operations share one file via `?action=` routing. Adding any new API file requires upgrading to Vercel Pro or merging into an existing file.

### Database Migrations (run in order v2 → v19)

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
| `check.sh` | Pre-push validation: JS syntax check on all HTML files, backslash-backtick hazard scan (per-file baseline: coach.html=2, client.html=0 — only flags NEW occurrences above baseline), vercel.json/vercelignore consistency check, serverless function count. Run automatically via git hook — do not bypass. |
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

**Supabase directly from browser (no backend middleware)**
The anon key + Row Level Security means clients can only see their own data (UUIDs are unguessable without a brute-force attack). Cutting the middleware layer eliminates an entire class of server management. The service role key is used only in Vercel serverless functions — never exposed to the browser.

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
2. Run all migrations v2–v19 in order against the new database
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

**June 2, 2026 — Coach Dashboard & Onboarding Session**

*Coach dashboard improvements (coach.html):*
- Add Client modal: removed "Regions Owned" field (never used). Renamed "Client has weekly coaching sessions" → "Coaching Client" throughout (modal, profile view, toggle buttons). Added "Setting Up for Diagnostic" checkbox — when checked, Tier and Email Delivery selectors appear inline; after the client is saved, a diagnostic is created automatically and linked. No need to go to the Diagnostics tab separately.
- Report tab: added "Upload Final Report" card as static HTML (not inside a JS template literal — avoids the V8 parse error pattern). Accepts PDF up to 8MB. Converts to base64, upserts into `diagnostic_report_drafts` with `content_json: { report_type: 'pdf_upload', pdf_base64: '...' }`, marks diagnostic as `report_final`. Client portal detects this flag and renders the PDF in an iframe with a download button instead of the HTML narrative renderer.

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

2. **Backslash-backtick scan** — Searches for literal `\`` characters in coach.html and client.html. Inside a `${}` expression in a template literal, `\`` is a syntax error (valid only inside a string literal, not as a template literal delimiter in expression context). This is the specific bug that broke login on May 29, 2026.

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

*Last updated: June 2, 2026. Update manually after any session that adds features, changes architecture, or introduces new failure modes not captured in the feature log.*
