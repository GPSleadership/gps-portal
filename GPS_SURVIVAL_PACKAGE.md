# GPS Leadership — Complete Survival Package
**Last updated:** 2026-06-10  
**Author:** Alex Tremble / GPS Leadership Solutions  
**Purpose:** Complete reconstruction guide — enough to rebuild every system from scratch on a new platform if needed.

---

## 1. What This System Is

GPS Leadership Solutions runs two distinct digital systems built around one core business: a leadership diagnostic and coaching firm that helps CEOs of multi-location, operations-heavy companies install leadership operating systems.

**The GPS Leadership Portal** (`portal.gpsleadership.org`) is the client-facing diagnostic platform. When Alex sells a 14-Day Executive Leadership Diagnostic engagement, this is where the work happens. Leaders log in, complete behavioral assessments, and receive AI-generated feedback tied to the TP3™ framework (Trust, Proactivity, Productivity → Profitability). Alex (the coach) gets a real-time view of every leader's scores, can send nudges, and delivers a final debrief report from the coach dashboard. The portal runs entirely serverless — no app server to maintain.

**The GPS Executive Console** (`gps-executive-console-deploy.html` deployed on Netlify) is Alex's private operations dashboard. It shows his live pipeline from GoHighLevel (via Make.com), his Google Calendar, bank account balances from multiple accounts, a 60-day cash flow forecast, action items from inbox sweeps, P&L metrics from QBO, and a "Send to Claude" button that pipes context directly into a conversation. This is a single HTML file with no server dependency — it connects to Supabase and the Make.com webhook directly from the browser.

Both systems were built to be operated by one person (Alex) and maintained by AI without a dedicated developer on retainer.

---

## 2. Technology Stack

| Service | What It Does | Why It Was Chosen | Fallback If Unavailable |
|---|---|---|---|
| **Vercel** | Hosts the portal HTML pages + all API serverless functions | Free tier, zero-config deployment from drag-and-drop, edge network, native serverless functions | Netlify Functions or Cloudflare Workers — identical serverless model, minor syntax differences |
| **Netlify** | Hosts the GPS Executive Console (single HTML file) | Instant drag-and-drop deploy, password protection via Netlify Identity | Vercel static deploy, or just serve the file locally via a browser |
| **Supabase** | PostgreSQL database + file storage + real-time subscriptions | Managed Postgres with a REST API out of the box, generous free tier, no ORM needed | Any Postgres host (Railway, Render, Neon) — the SQL schema files recreate everything |
| **Anthropic Claude API** | Powers "Ask Alex" AI coaching inside the portal | Best reasoning model available; GPT-4 is the fallback | Switch `model:` in `api/ask.js` to `gpt-4o` and swap the SDK |
| **Resend** | Sends all transactional email (invites, reminders, alerts) | Simple REST API, reliable deliverability, domain verification built-in | SendGrid or Postmark — same REST pattern, near-identical API shape |
| **GoHighLevel (GHL)** | CRM — tracks prospects, pipeline stages, contacts | Already in use before this system was built | Any CRM; pipeline data flows via Make.com webhook, not a direct API call |
| **Make.com** | Middleware — polls GHL pipeline and pushes data to Supabase | Handles the GHL → Supabase sync without custom code | Zapier or n8n — same webhook concept, different UI |
| **Google Calendar** | Displays Alex's upcoming events in the Executive Console | Embedded iframe — no API key required | Replace iframe with Calendly embed or any calendar provider |

---

## 3. File Map

### Portal Pages (HTML)
| File | What It Does |
|---|---|
| `client.html` | Leader-facing portal home — shows sprint progress, behavioral assessments, goals, AI nudges |
| `coach.html` | Alex's coaching dashboard — all clients, scores, sprint timelines, messaging |
| `diagnostic-leader.html` | Leader completes their full TP3 behavioral diagnostic |
| `diagnostic-coach.html` | Alex reviews completed diagnostics, adds coach commentary |
| `diagnostic-survey.html` | Direct reports and peers complete the 360 pulse survey |
| `diagnostic-sandbox.html` | Test/demo version — not visible to clients |
| `survey.html` | Standalone pulse check survey (used mid-sprint) |
| `client-DEMO.html` | Demo version of client portal for sales calls |

### API Functions (Vercel Serverless — `/api/`)
| File | What It Does |
|---|---|
| `ask.js` | Powers "Ask Alex" — takes a question + context, calls Claude API, returns coaching response |
| `diagnostic.js` | Core diagnostic engine — saves/retrieves scores, computes TP3 averages, triggers reminders |
| `survey.js` | Handles pulse survey submissions and storage |
| `get-client.js` | Returns client profile + sprint data for the leader portal |
| `accept-terms.js` | Records terms acceptance (required before portal access) |
| `start-sprint.js` | Initializes a new 14-day diagnostic sprint for a client |
| `submit-closeout.js` | Handles end-of-sprint submission and triggers debrief prep |
| `notify.js` | Sends one-off notifications to leaders via Resend |
| `send-reminders.js` | Cron-triggered — sends scheduled reminder emails to leaders with incomplete assessments |
| `survey-reminders.js` | Cron-triggered — nudges peers/direct reports to complete 360 surveys |
| `import-clients.js` | Bulk imports client records from CSV or JSON |
| `email-templates.js` | Shared email template library used by all sending functions |

### Executive Console
| File | What It Does |
|---|---|
| `gps-executive-console-deploy.html` | The live version deployed to Netlify — Alex's private ops dashboard |
| `gps-executive-console.html` | Working/dev copy — edit this, test locally, then copy to deploy version |

### Database (SQL)
| File | What It Does |
|---|---|
| `supabase-setup.sql` | Initial schema — creates all base tables |
| `supabase-migration-v2.sql` through `v19.sql` | Incremental schema changes — apply in order on a fresh database |
| `supabase-ask-alex.sql` | Schema additions for the Ask Alex AI feature |
| `supabase-add-*.sql` | Targeted column/table additions (30-day goal, archived flag, coach settings, etc.) |

### Config
| File | What It Does |
|---|---|
| `vercel.json` | Vercel deployment config — routes, function settings, cron schedules |
| `.env.example` | Template for all environment variables — fill in and add to Vercel settings |
| `.vercelignore` | Files excluded from Vercel deployment |

### Documentation
| File | What It Does |
|---|---|
| `GPS-PORTAL-ROADMAP.md` | Feature roadmap and upcoming build priorities |
| `PORTAL_STATE.md` | Current state of the portal — what's built, what's in progress |
| `SETUP-GUIDE.md` | Technical setup guide for onboarding the portal |
| `GPS_SURVIVAL_PACKAGE.md` | This file — complete reconstruction guide |

### Skills & Automation
| File | What It Does |
|---|---|
| `inbox-sweep.skill` | Claude Cowork skill that sweeps Gmail, calendar, and Fireflies for action items |
| `survival-package.skill` | Claude Cowork skill that creates this package — runs nightly at 9 PM |

---

## 4. Environment Variables

All variables must be added to Vercel → Project Settings → Environment Variables (Production + Preview).

| Variable | What It Does | Where to Get It |
|---|---|---|
| `SUPABASE_URL` | Supabase project API URL | supabase.com → Project Settings → API |
| `SUPABASE_ANON` | Public anonymous key (safe for browser use) | supabase.com → Project Settings → API |
| `SUPABASE_SECRET_KEY` | Service role key (server-only — never expose in client code) | supabase.com → Project Settings → API |
| `ANTHROPIC_API_KEY` | Authenticates calls to Claude API | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | Authenticates email sends | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | The "From" address for all outgoing email | Resend domain settings (gpsleadership.org must be verified) |
| `PORTAL_BASE_URL` | Full URL of the portal (used in email links) | `https://portal.gpsleadership.org` |
| `SITE_URL` | Same as portal URL (some functions use this alias) | `https://portal.gpsleadership.org` |
| `COACH_ALERT_EMAIL` | Where system alerts are sent | `alex@gpsleadership.org` |
| `CRON_SECRET` | Authenticates manual cron triggers via POST | Generate with `openssl rand -hex 32` |

---

## 5. Step-by-Step Setup Guide (Zero to Live)

### Step 1: Supabase
1. Go to supabase.com → New project → Name it "gps-leadership"
2. Note the Project URL and both API keys (anon and service role)
3. Go to SQL Editor
4. Run `supabase-setup.sql` first
5. Run each migration file in order: v2 → v3 → ... → v19
6. Run `supabase-ask-alex.sql`
7. Run each `supabase-add-*.sql` file
8. Verify tables exist: `clients`, `sprints`, `assessments`, `surveys`, `gps_settings`, `coach_notes`

### Step 2: Resend
1. Go to resend.com → Create account
2. Add domain `gpsleadership.org` → Follow DNS verification steps (adds TXT + MX records)
3. Create an API key → Copy it
4. Verify the from address `alex@gpsleadership.org` is authorized

### Step 3: Vercel
1. Go to vercel.com → New project → Import from GitHub (or drag-and-drop the project folder)
2. Go to Project Settings → Environment Variables
3. Add all variables from the table above
4. Deploy — Vercel auto-detects the `/api` folder and deploys serverless functions
5. Configure custom domain: `portal.gpsleadership.org` → point DNS to Vercel

### Step 4: Netlify (Executive Console)
1. Go to netlify.com → Add new site → Deploy manually
2. Drag `gps-executive-console-deploy.html` to the deploy area
3. Set a custom domain or use the Netlify URL
4. Enable password protection: Site settings → Identity → Enable → Set password

### Step 5: Make.com (Pipeline Sync)
1. Go to make.com → Create new scenario
2. Set trigger: GoHighLevel → Watch Pipeline Deals (poll every 15 min)
3. Set action: HTTP → POST to Supabase REST API with pipeline data
4. Activate the scenario

### Step 6: Google Calendar Embed
1. Go to Google Calendar → Settings → [Your Calendar] → Integrate calendar
2. Copy the embed iframe URL
3. Paste into the console HTML where the calendar section is

---

## 6. Architecture Decisions & Why

**Single-file HTML pages (no React/Vue/Next)**  
Every portal page is a single `.html` file with inline JS. This means zero build steps, zero npm dependencies, zero framework upgrades to manage. Anyone can open the file in a browser and see what it does. AI can read and edit it without needing to understand a build pipeline. Trade-off: some duplication across pages.

**Serverless API functions (no persistent server)**  
Vercel deploys each `/api/*.js` file as an isolated serverless function. No server to patch, no uptime to monitor, cold starts are fast enough for this use case. Cost is effectively zero on current traffic volume.

**Supabase over Firebase**  
Supabase uses standard PostgreSQL. Any SQL-literate developer or AI can query it, migrate it, or move it to another Postgres host. Firebase uses a proprietary document model that creates lock-in. The SQL migration files in this folder mean the database schema is fully reproducible.

**Make.com as middleware instead of direct GHL API**  
GHL's API is complex and changes frequently. Make.com handles the integration layer, so if GHL changes something, only the Make scenario needs to update — not the application code.

**No authentication library**  
The portal uses Supabase Row Level Security (RLS) + token-in-URL access links. Leaders get a unique link emailed to them. No passwords, no auth complexity. Trade-off: links expire or can be shared, but for a coaching context this is acceptable.

**Executive Console as a static file**  
The console is a single HTML file deployed to Netlify. It authenticates to Supabase using the anon key (hardcoded in the HTML, gated by Netlify password). This means it can be run locally by just opening the file, with no server. Alex can open it on any browser.

---

## 7. Key Data Model

```
clients
  id, name, email, company, role, invite_token (unique link), coach_id, status, created_at

sprints
  id, client_id, start_date, end_date, sprint_number, status (active/complete), coach_notes

assessments
  id, sprint_id, client_id, assessment_type (trust/proactivity/productivity), 
  score (0-10), behavior_ratings (JSON), submitted_at

surveys
  id, sprint_id, respondent_email, respondent_role (peer/direct_report/self),
  ratings (JSON), submitted_at, anonymous

gps_settings
  key (unique), value (JSON text), updated_at
  -- Used for: sweep_action_items, gps_action_done, gps_action_custom,
  --           gps_accounts (bank balances), monthly ops/comp targets

coach_notes
  id, client_id, sprint_id, note_text, created_at, created_by
```

---

## 8. Platform Migration Guide

### If Vercel goes away
1. All API functions are standard Node.js — move them to Netlify Functions (rename folder from `/api` to `/netlify/functions`) or Cloudflare Workers
2. Update `vercel.json` cron entries to equivalent cron config on new platform
3. No other code changes needed

### If Supabase goes away
1. Export data: Supabase dashboard → Backups → Download or pg_dump
2. Spin up a new Postgres on Railway, Render, or Neon
3. Run the SQL migration files in order on the new database
4. Update `SUPABASE_URL`, `SUPABASE_ANON`, `SUPABASE_SECRET_KEY` environment variables
5. Update the hardcoded Supabase URL + anon key inside `gps-executive-console-deploy.html` (search for `pbnkefuqpoztcxfagiod`)

### If Resend goes away
1. Replace `import { Resend } from 'resend'` with SendGrid or Postmark SDK in each api file that sends email
2. The email templates in `email-templates.js` are plain HTML — they work with any provider
3. Update `RESEND_API_KEY` to the new provider's key

### If Anthropic Claude goes away
1. In `api/ask.js`, replace the Anthropic SDK with the OpenAI SDK
2. Change `model: 'claude-sonnet-4-6'` to `model: 'gpt-4o'`
3. The system prompt and message format are compatible — minor syntax changes only

### If Make.com goes away
1. Build a direct integration with GHL's API in a new `/api/sync-pipeline.js` function
2. Or use Zapier with the same webhook approach
3. The Supabase table structure for pipeline data stays the same

---

## 9. Credentials & Account Locations

| Service | Account Email | URL |
|---|---|---|
| Vercel (portal hosting) | alex@gpsleadership.org | vercel.com |
| Netlify (console hosting) | alex@gpsleadership.org | netlify.com |
| Supabase (database) | alex@gpsleadership.org | supabase.com — project ID: `pbnkefuqpoztcxfagiod` |
| Anthropic (Claude API) | alex@gpsleadership.org | console.anthropic.com |
| Resend (email) | alex@gpsleadership.org | resend.com |
| GoHighLevel (CRM) | alex@gpsleadership.org | app.gohighlevel.com |
| Make.com (automation) | alex@gpsleadership.org | make.com |
| Claude desktop / Cowork | alex@gpsleadership.org | claude.ai |

*No passwords stored here. Use 1Password or your password manager.*

---

## 10. What's Currently Live vs. In Development

**Live and in active use:**
- GPS Leadership Portal (portal.gpsleadership.org) — fully deployed
- GPS Executive Console (Netlify) — deployed, updated May 28, 2026
- Inbox sweep skill (runs manually via Cowork)
- Make.com pipeline sync
- Outreach tracking system (GPS_Client_Contact_List.xlsx)

**Planned but not yet built:**
- GPS Portal mobile optimization
- Automated P&L sync from QuickBooks Online
- Portal onboarding flow for self-serve clients
- Proposal generation skill (SOW automation)

---

*This document should be updated any time a major feature is added, a new service is integrated, or the deployment architecture changes. The nightly ZIP backup captures the code; this document captures the knowledge of why it was built this way.*

*Generated: 2026-05-28 | GPS Leadership Solutions | alex@gpsleadership.org*
