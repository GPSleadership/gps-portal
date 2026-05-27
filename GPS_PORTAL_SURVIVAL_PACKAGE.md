# GPS Leadership Portal — Survival Package
### Everything needed to recreate this system from scratch

**Last updated:** May 27, 2026  
**GitHub repo:** https://github.com/GPSleadership/gps-portal  
**Live URL:** https://portal.gpsleadership.org  
**Coach dashboard:** https://portal.gpsleadership.org/coach  
**Client portal:** https://portal.gpsleadership.org/client  

---

## 1. What This System Is

The GPS Leadership Portal is a client-facing delivery platform for Alex Tremble / GPS Leadership Solutions. It handles two core products:

**A. 90-Day Leadership Coaching Program**
- Clients get a personal portal where they receive and track their 90-day action plan
- Weekly check-ins, sprint tracking, stakeholder feedback surveys
- "Ask Alex" — an AI assistant (Claude) trained on GPS frameworks (TP3™)
- Coach dashboard for managing all clients, reviewing check-ins, and tracking engagement

**B. 14-Day Executive Leadership Diagnostic**
- Full 360-style leadership assessment using the TP3™ framework (Trust, Proactivity, Productivity → Profitability)
- Leader completes self-assessment; 10–15 raters complete surveys
- Claude generates a full narrative report with scored dimensions, themes, and 90-day recommendations
- Report delivered through the client portal with a coach debrief session

---

## 2. Technology Stack

| Layer | Service | What it does |
|-------|---------|-------------|
| Hosting | Vercel (Hobby plan) | Serves all HTML files + runs serverless API functions |
| Database | Supabase (PostgreSQL) | All data: clients, diagnostics, raters, surveys, emails |
| Email | Resend | All transactional email (invites, reminders, reports) |
| AI | Anthropic Claude API (claude-sonnet-4-6) | Ask Alex Q&A + diagnostic report generation |
| Domain | portal.gpsleadership.org | Custom domain pointed to Vercel |
| Source control | GitHub (GPSleadership/gps-portal) | All code lives here |

**Why this stack:**
- Vercel: zero-config deployment from GitHub, auto-deploys on push, free tier covers the load
- Supabase: PostgreSQL with a REST API (PostgREST) accessible directly from browser JS — no separate backend needed
- Resend: modern email API with excellent deliverability, simple Node SDK
- All files are single HTML files — no build step, no framework, no bundler. Open the file and it works.

---

## 3. File Map — What Every File Does

### HTML Pages (user-facing)
```
client.html          → Client portal (login via ?token=X)
                       Tabs: My Plan, My Results, My Diagnostic, Ask Alex
                       
coach.html           → Coach dashboard (password-protected)
                       Tabs: Dashboard, Clients, Diagnostics, Team Reports, Email Log
                       
diagnostic-survey.html → Rater survey (accessed via token link in invite email)
                          TP3 V2 question bank, section progress bar, self vs rater branching
                          
survey.html          → Stakeholder feedback survey (90-day coaching program)

diagnostic-sandbox.html → Clickable prototype / design reference (not production)
diagnostic-leader.html  → Legacy leader portal (superseded by client.html)
diagnostic-coach.html   → Legacy coach diagnostic view (superseded by coach.html)
client-DEMO.html     → Demo version of client portal (no live data)
```

### API Functions (Vercel serverless, all in /api/)
```
diagnostic.js        → Master diagnostic handler. Routes via ?action= param:
                         send-invites      → sends rater survey emails via Resend
                         generate-question → generates AI custom rater question (G1)
                         generate-report   → generates full TP3 report via Claude
                         generate-team-report → generates multi-client team report
                         finalize-report   → marks report final, emails client
                         reminders         → cron: rater reminders + T-2 alerts + 
                                            auto-lock plans + email delivery health +
                                            portal engagement nudges
                                            
ask.js               → Ask Alex Q&A endpoint. Calls Claude with GPS system prompt.
                       Rate-limited to prevent abuse.
                       
get-client.js        → Client authentication. GET ?token=X → returns client record.
                       POST {email} → sends portal link recovery email.
                       
notify.js            → Email notification hub for coaching program (check-ins,
                       plan submissions, stakeholder responses, welcome sequence)
                       
send-reminders.js    → Weekly reminders cron for coaching clients (check-in nudges,
                       auto-archive after 45 days inactive)
                       
survey-reminders.js  → Daily reminders for stakeholder surveys, auto-confirm logic,
                       welcome reminder email sequence
                       
survey.js            → Handles stakeholder survey load + submission
accept-terms.js      → Records AI terms acceptance timestamp in DB
start-sprint.js      → Starts a new 13-week sprint for a client
submit-closeout.js   → Handles 90-day plan closeout submission
import-clients.js    → Bulk client import from CSV
email-templates.js   → Returns email template previews for coach review
```

### Database Migrations (run in order v2 → v16)
```
supabase-migration-v2.sql   → email_log, admin_accounts, checkin_drafts
supabase-migration-v3.sql   → stakeholders, survey_responses, survey_tokens
supabase-migration-v4.sql   → full schema rewrite with sprint system
supabase-migration-v5.sql   → confirmed_at on stakeholders
supabase-migration-v6.sql   → sprint_number on checkins
supabase-migration-v7.sql   → last_active_at on clients (45-day auto-archive)
supabase-migration-v8.sql   → portal_first_active_at on clients (90-day access window)
supabase-migration-v9.sql   → continuation_step for post-expiry email sequence
supabase-migration-v10.sql  → welcome_reminder_step for onboarding emails
supabase-migration-v11.sql  → preferred_name, title, org on clients; coach_profile table
supabase-migration-v12.sql  → diagnostic-related client fields
supabase-migration-v13.sql  → diagnostics + diagnostic_raters + diagnostic_report_drafts
                              + diagnostic_question_overrides + diagnostic_team_reports
supabase-migration-v14.sql  → RLS policies, indexes, email_log diagnostic columns
supabase-migration-v15.sql  → alert_t2_sent_at, survey_closed_at on diagnostics
supabase-migration-v16.sql  → debrief fields, plan fields, coaching_notes, interview_notes
```

### Config
```
vercel.json          → URL rewrites, cron schedules, API function timeouts (maxDuration)
```

---

## 4. Environment Variables (Required)

Set these in Vercel → Project Settings → Environment Variables:

```
SUPABASE_URL          https://[your-project].supabase.co
SUPABASE_ANON         eyJ... (anon/public key — safe for browser)
SUPABASE_SECRET_KEY   eyJ... (service role key — server-side only, never expose)

ANTHROPIC_API_KEY     sk-ant-... (Claude API key)

RESEND_API_KEY        re_... (Resend API key)
RESEND_FROM_EMAIL     Alex Tremble – GPS Leadership <alex@gpsleadership.org>

PORTAL_BASE_URL       https://portal.gpsleadership.org
SITE_URL              https://portal.gpsleadership.org  (same as above)

COACH_ALERT_EMAIL     alex@gpsleadership.org
CRON_SECRET           [random string — used to authenticate manual cron triggers]
```

**Where to get each:**
- Supabase keys: Supabase dashboard → Project Settings → API
- Anthropic key: console.anthropic.com → API Keys
- Resend key: resend.com → API Keys
- CRON_SECRET: generate any random string (openssl rand -hex 32)

---

## 5. How to Recreate From Scratch

### Step 1: Supabase Setup
1. Create new Supabase project at supabase.com
2. Go to SQL Editor
3. Run migrations IN ORDER: v2.sql through v16.sql
4. Note your project URL and both API keys

### Step 2: Resend Setup
1. Create account at resend.com
2. Add domain: gpsleadership.org
3. Add DNS records (DKIM + SPF + DMARC) — Resend shows you exactly what to add
4. Create API key with Send access
5. Verify domain is active before sending

### Step 3: Anthropic Setup
1. Create account at console.anthropic.com
2. Add billing method
3. Create API key
4. Note: model used is claude-sonnet-4-6

### Step 4: GitHub Setup
1. Create repo (public or private)
2. Push all files from local folder
3. Keep .gitignore — never commit .env files

### Step 5: Vercel Setup
1. Create account at vercel.com
2. Import GitHub repo
3. Add all environment variables (Section 4 above)
4. Add custom domain: portal.gpsleadership.org
5. Point domain DNS → Vercel (they'll show you the records)
6. Verify deployment works at the Vercel-provided URL first

### Step 6: Cron Verification
Three cron jobs are configured in vercel.json:
- `/api/send-reminders` — Mondays at 2pm UTC (coaching program)
- `/api/survey-reminders` — Daily at 2pm UTC (stakeholder surveys)
- `/api/diagnostic?action=reminders` — Daily at 2pm UTC (diagnostic system)

Vercel Hobby plan supports cron jobs. Verify they're listed in Vercel → Project → Cron Jobs.

### Step 7: Coach Login
The coach dashboard uses a hardcoded password stored in the `admin_accounts` table.
After setup, insert a row: `INSERT INTO admin_accounts (name, email, password, role) VALUES ('Alex Tremble', 'alex@gpsleadership.org', '[password]', 'admin');`

---

## 6. Architecture Decisions & Why

**Why single HTML files instead of React/Next.js?**
Simple wins. No build step, no dependency management, no npm vulnerabilities. Files can be opened locally, edited in any text editor, and deployed by pasting into Vercel. Alex can see the entire codebase without a development environment.

**Why Supabase directly from the browser (no backend)?**
The anon key + Row Level Security (RLS) means clients can only see their own data (UUIDs are unguessable). Cuts out an entire middleware layer. The service role key is only used in serverless functions, never exposed to clients.

**Why Vercel Hobby instead of a VPS?**
Zero ops. No server maintenance, automatic SSL, auto-deploy from GitHub. Hobby plan is free and handles this traffic easily. The 12-function limit is reached — any new API endpoints must be added as routes inside existing files using `?action=` routing.

**Why Resend instead of SendGrid/Mailchimp?**
Better deliverability for transactional email, simpler API, developer-friendly. GPS uses Resend for all automated email. Marketing email (newsletters) goes through a separate system.

**Why `?action=` routing in api/diagnostic.js?**
Vercel Hobby plan caps at 12 serverless functions. We're at exactly 12. All diagnostic operations (6 actions) live in one file routed by query param. This is the ceiling — if you need more functions on Vercel, upgrade to Pro.

**Why store report as JSON with `full_narrative` as pre-rendered HTML?**
Claude generates the narrative once. Storing it as HTML lets the portal render it directly without re-processing. The JSON also stores the scored dimensions separately, so they can be displayed in structured sections.

**Why localStorage for weekly nudge tracking?**
The weekly leadership prompts (weeks 1-3) track which prompts a client has seen using localStorage. This is intentionally lightweight — if they clear localStorage, they see the prompt again (harmless). Avoids a DB column for a low-stakes UX feature.

---

## 7. Key Data Model (Core Tables)

```
clients
  id, name, email, org, title, token (portal login), portal_first_active_at,
  last_active_at, is_active, is_archived, plan_submitted_at, current_sprint_number,
  preferred_name, ai_terms_accepted, coaching_sessions_enabled, industry

diagnostics
  id, client_id (→clients), client_name, client_email, client_title, client_org,
  status (setup → self_assessment_pending → survey_open → survey_closed → 
           report_draft → report_final → debrief_complete → plan_active),
  tier (standard/pro), email_delivery_mode,
  [self-report fields: self_strengths, self_blind_spots, self_leadership_style...],
  [succession fields: self_three_year_vision, self_successor_candidates...],
  intake_notes, coaching_notes, interview_notes,
  report_finalized_at, debrief_completed_at, plan_status, plan_locked_at

diagnostic_raters
  id, diagnostic_id, name, email, token (survey access), is_self, role,
  invited_at, completed_at, reminder_1_sent_at, reminder_2_sent_at, email_bounced

diagnostic_report_drafts
  id, diagnostic_id, version (1,2,3...), content_json (full report as JSON + HTML narrative),
  generated_at, model_used, input_tokens, output_tokens

email_log
  id, sent_at, recipient_email, email_type, status (sent/error), error_details, resend_id

clients → checkins → sprints (coaching program check-in system)
clients → stakeholders → survey_tokens → survey_responses (stakeholder feedback)
```

---

## 8. GPS Frameworks Embedded in the System

**TP3™ Framework (Trust, Proactivity, Productivity → Profitability)**
The core leadership model. All diagnostic questions, report sections, and Ask Alex prompts are organized around TP3. The report has scored dimensions under each pillar plus an Execution & Accountability pillar and a Succession & Future Self section (Pro tier).

**14-Day Executive Leadership Diagnostic**
The flagship diagnostic product. 35 rater questions across 5 TP3 dimensions + custom AI-generated succession question (G1). Minimum 7 rater responses for report generation. Full narrative report generated by Claude with strengths, blind spots, patterns, and 90-day recommendations.

**Ask Alex**
AI Q&A trained on GPS frameworks. System prompt includes client context (industry, plan status, preferred name), GPS voice (direct, candid, calm), and industry-specific variations (standard vs government). Rate-limited per day. Terms acceptance gate.

---

## 9. Premortem Analysis — Failure Modes Addressed

This system was analyzed using a premortem methodology (imagine it failed, work backward to causes). 35 failure modes identified, triaged by likelihood × severity.

### P0 (Critical — implemented)
1. No gate before report finalize → added 3-layer review: preview modal + checkbox + named confirm dialog
2. Report generated on thin data → minimum 7-rater gate + amber warning + CONFIRM override
3. No portal link recovery → POST route on get-client.js, recovery form in client.html
4. RLS not verified → confirmed via Supabase SQL editor
5. Email authentication → DKIM/SPF/DMARC records on gpsleadership.org via Resend

### P1 (High — implemented)
6. Rater double-submission → `_surveySubmitting` flag + `completed_at` check
7. No rater removal → × button in client portal with guards (not self, not complete, not finalized)
8. Claude API flakiness → retry logic (2 retries, 3s delay, on 529/500)
9. Runaway report costs → MAX_REPORT_DRAFTS = 5 per diagnostic
10. Email delivery failures → Section 4 in reminders cron: spike detection alert to coach
11. Client misses report email → report-ready banner in portal (persists across sessions)
12. Client has no portal token → finalize-report API returns 422 with clear message
13. Portal engagement → weekly leadership prompt (weeks 1-3), 7-day nudge email, last-active in coach view

### Known P2 Items (to address next)
- Bounce visibility in coach Raters tab (email_bounced tracked in DB, not shown in UI)
- Rater email correction after invite sent
- Diagnostic text search (filter buttons exist, name search missing)
- Close-survey-with-zero-completions warning
- Diagnostic archive/hide for completed diagnostics
- All-raters-complete notification when 7th rater finishes
- Diagnostic data export (CSV/JSON)
- Survey token hard-block when diagnostic is already closed
- Generate-question rate limit per diagnostic
- Mobile polish on diagnostic-survey.html

---

## 10. Cron Schedule

All times UTC. Vercel runs these automatically.

| Job | Schedule | File | What it does |
|-----|----------|------|-------------|
| Coaching reminders | Mondays 2pm UTC | api/send-reminders.js | Check-in nudges, auto-archive |
| Survey reminders | Daily 2pm UTC | api/survey-reminders.js | Stakeholder survey nudges, auto-confirm, welcome sequence |
| Diagnostic reminders | Daily 2pm UTC | api/diagnostic.js?action=reminders | Rater R1/R2 reminders, T-2 alerts, plan auto-lock, email health check, portal nudges |

To trigger manually (for testing): POST to the endpoint with `{ "manual_trigger": true }` and `Authorization: Bearer [CRON_SECRET]`

---

## 11. If You're Starting Over on a New Platform

The entire system is portable. Here's what you'd need:

**Minimum to recreate:**
1. The HTML files (self-contained, just need environment variables wired in)
2. The API functions (12 files, Node.js, standard fetch calls)
3. A PostgreSQL database (Supabase or any Postgres host)
4. An email API (Resend or SendGrid)
5. An Anthropic API key
6. A static file + serverless function host (Vercel, Netlify, Railway, etc.)

**On a different platform (e.g., Railway, Render, Fly.io):**
- All API functions would need to be wrapped in an Express/Fastify server
- The `export default function handler(req, res)` signature would change to `app.post('/api/endpoint', handler)`
- Everything else stays the same

**Without Supabase:**
- Any PostgreSQL database works
- Replace the `sb()` helper in each API file with a `pg` or `postgres` client
- The SQL schema (all migrations) is standard PostgreSQL — runs on any Postgres

**Without Vercel:**
- Host HTML files anywhere (Netlify, S3 + CloudFront, GitHub Pages)
- Run API functions as Express routes on any Node.js host
- Set up cron jobs via your platform's scheduler or a service like Upstash

---

## 12. Contact & Credentials Location

- **Supabase:** supabase.com → GPSleadership organization
- **Vercel:** vercel.com → GPSleadership team
- **Resend:** resend.com → GPS Leadership account
- **Anthropic:** console.anthropic.com → GPS Leadership account
- **GitHub:** github.com/GPSleadership
- **Domain registrar:** wherever gpsleadership.org is registered (check DNS settings there)

All API keys and secrets are stored as Vercel environment variables — never in the codebase.

---

*This document was generated on May 27, 2026. The system continues to evolve — update this document when major changes are made.*
