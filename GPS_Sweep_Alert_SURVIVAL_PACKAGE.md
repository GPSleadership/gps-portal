# GPS Sweep & Portal Alert System — Survival Package
**Last updated:** May 29, 2026
**System name:** GPS Inbox Sweep + Cross-Session Portal Alert
**Documented by:** Cowork session (alex@gpsleadership.org)

---

## 1. What This System Is

This is the automated operations layer for Alex Tremble's daily workflow at GPS Leadership Solutions. It has two connected pieces:

**The Inbox Sweep** runs four times a day (8am, noon, 5pm, midnight ET). It processes every unread email in Alex's Gmail, classifies each one (needs Alex's reply, EA Anna should handle, informational only, or promotional), labels it, removes it from the inbox, collects action items from Fireflies meeting recordings, checks a Google Drive folder for Navy Federal and credit card screenshots and writes parsed balances to Supabase, and delivers a prioritized action summary. The goal: inbox zero every sweep window, and a single actionable list Alex can read in two minutes.

**The Portal Alert System** sits inside the sweep as Step 8. When the sweep detects a portal-relevant issue — a failed Vercel deployment, a Supabase error, a Make.com scenario failure tied to the GPS portal — it writes a structured notification to Supabase and immediately spawns a context-aware sub-agent to investigate and attempt a fix. The sub-agent doesn't act blindly: before touching anything, it loads the portal's architectural context from Supabase (`portal_context` key) and reads `PORTAL_STATE.md`, the authoritative document for everything built in the portal. This gives the sub-agent the same working knowledge the dedicated portal thread would bring to the problem.

**The Portal Context Sync** is a companion skill used by the portal thread (the Cowork session that builds and maintains the GPS Leadership portal). At the end of every portal working session, the portal thread runs this skill to write a structured snapshot of the current build state to Supabase. That snapshot is what the sweep's sub-agents read before acting.

Together, these three components create a cross-session communication system: the sweep detects, the portal thread's context store enables informed action, and the sub-agent fixes without needing a human to open a new session.

---

## 2. Technology Stack

| Service | What it does | Why chosen | Alternative if unavailable |
|---|---|---|---|
| **Anthropic / Claude** | Runs the sweep, classifies emails, spawns sub-agents, writes action items | Powers all AI reasoning in Cowork sessions | OpenAI GPT-4 or Google Gemini with prompt adaptation |
| **Claude Cowork** | Session environment where the sweep and portal sync skills run | Provides file access, MCP tools, scheduled tasks | Claude Code CLI with same MCPs configured |
| **Gmail MCP** (`mcp__cb278474`) | Reads inbox threads, applies labels, removes from inbox | Direct API-backed Gmail access | Google Apps Script or Gmail API directly |
| **Fireflies MCP** (`mcp__ca1e21ff`) | Fetches meeting transcripts and AI-generated action items | Auto-joins Zoom/Google Meet and generates summaries | Otter.ai, Grain, or manual meeting notes |
| **Google Drive MCP** (`mcp__e4dc383e`) | Reads Navy Federal and credit card balance files | Alex uploads PDFs/screenshots; Claude reads and parses | Manual balance entry or a different file sync |
| **Supabase** | Stores action items, account balances, portal context, portal notifications | Already the GPS portal's database; consistent credentials | Any PostgreSQL host (Neon, Railway, PlanetScale) |
| **Vercel** | Hosts the GPS Leadership portal | Serverless deployment with GitHub integration | Netlify, Railway, or Cloudflare Pages |
| **Claude Scheduled Tasks** | Triggers the sweep at 8am, noon, 5pm, midnight ET | Built into Cowork; runs without manual intervention | Cron job via Make.com, n8n, or system cron |

---

## 3. File Map

### Skill files (stored in Tool Creation folder and installed as plugins)

| File | What it does |
|---|---|
| `inbox-sweep.skill` | **Previous version** of the sweep (7 steps — no portal alert). Kept as reference. |
| `inbox-sweep-updated.skill` | **Current version** of the sweep (8 steps — includes portal alert Step 8). Install this to replace the old one. |
| `portal-context-sync.skill` | New skill for the portal thread. Writes build state to Supabase; checks for incoming notifications; provides context-load instructions to sub-agents. |

### Source files (unpackaged SKILL.md content)

| File | Location | What it does |
|---|---|---|
| `inbox-sweep/SKILL.md` | Inside `inbox-sweep-updated.skill` (ZIP) | Full sweep instructions: email classification rules, label IDs, Fireflies integration, Drive balance parsing, Supabase writes, summary format, portal alert logic |
| `portal-context-sync/SKILL.md` | `Tool Creation/portal-context-sync/SKILL.md` | Three modes: write context snapshot (end of portal session), check for incoming notifications (start of session), load context for sub-agents |

### Supabase keys (in `gps_settings` table, project `pbnkefuqpoztcxfagiod`)

| Key | Schema | Written by | Read by |
|---|---|---|---|
| `sweep_action_items` | JSON array of action item objects | Inbox sweep (Steps 4, 8) | GPS Executive Console dashboard |
| `accounts` | JSON object of Profit First balances | Inbox sweep (Step 6) | GPS Executive Console dashboard |
| `portal_context` | JSON snapshot of portal build state | Portal thread (portal-context-sync skill, Mode A) | Sweep sub-agents (Mode C); portal thread (Mode B) |
| `portal_notifications` | JSON array of portal alert objects | Inbox sweep (Step 8) | Portal thread (portal-context-sync skill, Mode B); sub-agents |

### Related context files (in Tool Creation folder)

| File | What it does |
|---|---|
| `PORTAL_STATE.md` | Authoritative reference for everything built in the GPS Leadership portal. Sub-agents read this before touching the portal codebase. |
| `GPS-PORTAL-ROADMAP.md` | Portal feature roadmap |
| `GPS_PORTAL_SURVIVAL_PACKAGE.md` | Survival package for the GPS portal itself (separate from this document) |
| `GPS_SURVIVAL_PACKAGE.md` | Survival package for GPS Leadership operations overall |

---

## 4. Environment Variables / Credentials

### Gmail MCP
No env vars required — credentials managed by Cowork plugin. If recreating: connect Gmail MCP via Cowork plugin settings using alex@gpsleadership.org.

### Fireflies MCP
No env vars required — credentials managed by Cowork plugin. If recreating: connect Fireflies MCP with the alex@gpsleadership.org account.

### Google Drive MCP
No env vars required — credentials managed by Cowork plugin. Drive folder ID for balance files: `1RwvPVm0rqD-UuvjKN97nEqdipE9xZPlw`

### Supabase (GPS portal project)
These are hardcoded in the sweep skill (anon key — safe to store in skill files, not a service role key):

```
Project ID:     pbnkefuqpoztcxfagiod
Project URL:    https://pbnkefuqpoztcxfagiod.supabase.co
Anon key:       eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibmtlZnVxcG96dGN4ZmFnaW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTkwMzEsImV4cCI6MjA5MjU3NTAzMX0.DxEMR2Ckt9QJlRMkFenEZn-gzsVoi8-6CFcAItTePjo
```

**Note:** The anon key has read/write access to `gps_settings` via permissive RLS. The service role key (stored only in Vercel environment variables) is separate and more privileged — not used by the sweep.

### Gmail label IDs (hardcoded in sweep skill)
```
Action – Alex:  Label_4
Action – EA:    Label_5
FYI:            Label_6
Promo:          Label_7
Financials:     Label_7595396601619497493
Executive Appeal / Podcast: Label_1793398400413017601
```

These IDs are account-specific to alex@gpsleadership.org. If labels are deleted and recreated, the IDs will change and the skill must be updated.

---

## 5. Step-by-Step Setup Guide

### If rebuilding from scratch on a new machine or platform:

**Step 1 — Install Cowork**
Download and install the Claude Desktop app. Enable Cowork mode. Sign in with alex@gpsleadership.org.

**Step 2 — Connect MCPs**
In Cowork plugin settings, connect:
- Gmail (alex@gpsleadership.org)
- Fireflies (alex@gpsleadership.org account)
- Google Drive (alex@gpsleadership.org)
- Supabase (use the project credentials above)

**Step 3 — Install the skill files**
Open `inbox-sweep-updated.skill` in Cowork — click "Install skill."
Open `portal-context-sync.skill` in Cowork — click "Install skill."

**Step 4 — Set up the scheduled sweep task**
In Cowork, create a scheduled task that runs the inbox-sweep skill:
- 8:00 AM ET — morning sweep
- 12:00 PM ET — midday sweep
- 5:00 PM ET — EOD sweep
- 12:00 AM ET — midnight sweep

The skill auto-detects which window it's in based on current time.

**Step 5 — Verify Supabase keys**
In Supabase project `pbnkefuqpoztcxfagiod`, confirm these keys exist in `gps_settings`:
- `sweep_action_items`
- `accounts`
- `portal_context`
- `portal_notifications`

If missing, run this SQL:
```sql
INSERT INTO gps_settings (key, value, updated_at) VALUES
  ('portal_notifications', '[]', NOW()),
  ('portal_context', '{"last_updated":null,"note":"Not yet synced"}', NOW())
ON CONFLICT (key) DO NOTHING;
```

**Step 6 — First portal context sync**
Open the portal thread (the Cowork session that works on `portal.gpsleadership.org`). Run the portal-context-sync skill (Mode A) to write the current portal state to Supabase. This arms the sub-agent system — without this, any sweep-spawned sub-agent will still fall back to `PORTAL_STATE.md` but won't have session-specific notes.

**Step 7 — Test**
Send a test email with subject "Failed production deployment" to alex@gpsleadership.org and run a manual sweep. Confirm: (a) email gets labeled Action–Alex and removed from inbox, (b) a portal_notifications record is written to Supabase, (c) a sub-agent is spawned.

---

## 6. Architecture Decisions & Why

**Why hardcode the Supabase anon key in the skill file?**
The anon key is designed to be client-side safe — it has no more access than what RLS policies allow (which for `gps_settings` is read/write for authenticated-like access). Storing it in the skill means the sweep works without environment variable configuration on any machine. If the key is ever rotated, update the skill files and repackage.

**Why use `gps_settings` (key-value) instead of dedicated tables?**
The `gps_settings` table already existed for the portal's coach settings. Using it for sweep data avoids schema migrations and keeps everything in one place. The downside is no per-row indexing — acceptable given the small data volume.

**Why write portal context to Supabase instead of just reading PORTAL_STATE.md?**
`PORTAL_STATE.md` is the architectural ground truth, but it's a file on Alex's local machine. A sub-agent spawned during a sweep (in an isolated sandbox) needs a network-accessible source for the most recent session notes — things that happened in the last portal session that haven't been committed to the file yet. Supabase is that bridge.

**Why spawn a sub-agent immediately rather than waiting for the portal thread?**
Time-sensitive issues (production deployment failures, Supabase errors) degrade user experience every minute they sit. A sub-agent with good context can at minimum diagnose the problem, attempt a rollback, and leave clear findings — all while Alex is asleep or in a meeting. The portal thread reviews and confirms when it next opens.

**Why is `PORTAL_STATE.md` read by sub-agents even when `portal_context` exists?**
`portal_context` is a compact snapshot updated at session end — fast to load. `PORTAL_STATE.md` has the full architectural detail including schema, file maps, and tool libraries. Sub-agents load both: the Supabase key for recent session state, the file for complete context.

**Why separate `inbox-sweep` from `portal-context-sync` as two skills?**
The sweep runs on a fixed schedule and doesn't need portal awareness most of the time. The portal thread doesn't need to know about email. Keeping them separate means each skill is readable, testable, and modifiable without touching the other.

---

## 7. Key Data Models

### `gps_settings` table
```
key        text (primary key)
value      text (JSON string — parse at read time)
updated_at timestamp
```

### `portal_context` value schema
```json
{
  "last_updated": "ISO timestamp",
  "updated_by": "portal-session",
  "portal_state_md_path": "path to PORTAL_STATE.md",
  "deployment": {
    "url": "portal.gpsleadership.org",
    "platform": "Vercel",
    "repo": "https://github.com/GPSleadership/gps-portal",
    "supabase_project": "pbnkefuqpoztcxfagiod"
  },
  "current_focus": "string",
  "files_modified": ["array of filenames"],
  "pending_items": ["array of strings"],
  "known_issues": ["array of strings"],
  "session_notes": "free text"
}
```

### `portal_notifications` value schema (array)
```json
[
  {
    "id": "sweep-YYYYMMDD-HHMM-portal-n",
    "detected_at": "ISO timestamp",
    "trigger": "one-line description",
    "email_subject": "string",
    "email_sender": "string",
    "severity": "high | normal",
    "sub_agent_action": "null or string",
    "sub_agent_findings": "null or string",
    "resolved": false,
    "resolved_at": null
  }
]
```

### `sweep_action_items` value schema (array)
```json
[
  {
    "id": "sweep-YYYYMMDD-HHMM-email-n OR ff-meetingId-n",
    "text": "one clear sentence: what Alex needs to do",
    "from": "sender or meeting title",
    "priority": "high | normal",
    "date": "ISO timestamp",
    "dismissed": false
  }
]
```

---

## 8. Platform Migration Guide

### If Anthropic / Claude goes away
The sweep logic is entirely in the SKILL.md files — it's just instructions. The classification rules, label IDs, Supabase credentials, and summary format can be ported to any AI system that can call Gmail, Fireflies, Google Drive, and Supabase APIs. The biggest effort is recreating the MCP connections (currently handled by Cowork plugins) as direct API integrations.

### If Cowork goes away
Use Claude Code CLI with the same MCPs configured. Scheduled tasks would need to move to a cron job (system cron, Make.com, or n8n) that calls `claude -p` with the sweep SKILL.md.

### If Supabase goes away
Replace with any PostgreSQL host. The `gps_settings` table is a simple key-value store — create it on the new host and update the connection URL and anon key in the skill files. No complex schema.

### If Gmail MCP goes away
Fall back to Google Apps Script or direct Gmail API calls. The classification logic stays the same — just the API calls change.

### If Fireflies goes away
The sweep gracefully skips the Fireflies step if no transcripts are returned. Switch to Otter.ai, Grain, or Fathom — any tool that produces structured meeting action items via API.

---

## 9. Credentials & Account Locations

| Service | Account | Location |
|---|---|---|
| Claude / Cowork | alex@gpsleadership.org | claude.ai |
| Gmail | alex@gpsleadership.org | gmail.com |
| Fireflies | alex@gpsleadership.org | fireflies.ai |
| Google Drive | alex@gpsleadership.org | drive.google.com (folder: 1RwvPVm0rqD-UuvjKN97nEqdipE9xZPlw) |
| Supabase | GPS portal project | supabase.com → GPSleadership organization → GPS-portal project |
| Vercel | GPS portal deployment | vercel.com → GPS Leadership Solutions team |

---

## 10. What to Do With This Document

Copy `GPS_Sweep_Alert_SURVIVAL_PACKAGE.md` and `GPS_Sweep_Alert_Backup_2026-05-29.zip` to an external hard drive.

If you ever need to rebuild: give a developer or AI the zip file and this document. They have everything needed to recreate the system on any platform — no other context required.

Update this document whenever the sweep skill is significantly modified, a new Supabase key is added, or the portal alert logic changes.

---

*Last updated: May 29, 2026. System built by GPS Leadership Solutions Cowork session.*
