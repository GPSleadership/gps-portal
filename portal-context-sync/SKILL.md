---
name: portal-context-sync
description: Syncs the GPS Leadership portal's current working state to Supabase so that any agent — including automated sweep sub-agents — can load full context before touching the codebase. Use this skill at the END of every portal working session, any time you finish building or modifying something in the GPS portal, or when Alex says "sync the portal", "save portal state", "update portal context", or "record what we built." Also use it when starting a session to CHECK whether there are unread portal notifications left by the inbox sweep. If a sweep agent has flagged an issue and spawned a sub-agent, this skill is what gives that sub-agent the architectural knowledge to fix things the right way — not generically.
---

# Portal Context Sync

You are managing the GPS Leadership portal's shared memory system. The portal lives at `portal.gpsleadership.org`, deployed via Vercel, with code in GitHub at `https://github.com/GPSleadership/gps-portal` and data in Supabase project `pbnkefuqpoztcxfagiod`.

The authoritative reference for everything built is:
```
/Users/alex.tremble/Documents/Claude/Projects/Tool Creation/PORTAL_STATE.md
```

Always read this file before doing anything else in this skill.

---

## Supabase credentials

Both fields use the same token:
```
apikey / Bearer: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibmtlZnVxcG96dGN4ZmFnaW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTkwMzEsImV4cCI6MjA5MjU3NTAzMX0.DxEMR2Ckt9QJlRMkFenEZn-gzsVoi8-6CFcAItTePjo
```

Use the Supabase MCP (`execute_sql`, project ID: `pbnkefuqpoztcxfagiod`) for all reads and writes. The table is `gps_settings` with columns `key` (text), `value` (text), `updated_at` (timestamp).

---

## Mode A — Write context snapshot (end of session)

Run this at the end of any portal working session to publish the current state.

### Step 1: Read PORTAL_STATE.md

Read the full file. Extract:
- **Pending items** from Section 12 (numbered list, note which are checked ✅ vs open)
- **Integration status** from Section 5 (what's live vs pending)
- **Any issues, notes, or fragile areas** you're aware of from this session

### Step 2: Build the snapshot object

Construct this JSON. Fill in `current_focus`, `files_modified`, `known_issues`, and `session_notes` based on what actually happened this session. Be specific — this is what a sub-agent will read before touching the codebase.

```json
{
  "last_updated": "[ISO timestamp]",
  "updated_by": "portal-session",
  "portal_state_md_path": "/Users/alex.tremble/Documents/Claude/Projects/Tool Creation/PORTAL_STATE.md",
  "deployment": {
    "url": "portal.gpsleadership.org",
    "platform": "Vercel",
    "repo": "https://github.com/GPSleadership/gps-portal",
    "supabase_project": "pbnkefuqpoztcxfagiod"
  },
  "current_focus": "[What this session was working on — e.g., 'Integrating Q&A tab into client.html']",
  "files_modified": ["client.html", "api/ask.js"],
  "pending_items": [
    "Test multi-behavior Form B with a new client",
    "Alex to add ANTHROPIC_API_KEY to Vercel",
    "Upload GPS Baseline Snapshot PDF to Drive"
  ],
  "known_issues": [
    "Q&A tool not yet connected to live portalContext — still using empty object",
    "2 tool links missing (GPS Baseline Snapshot, CEO Financial Clarity Snapshot)"
  ],
  "session_notes": "[Anything a sub-agent must know before touching this codebase. Include gotchas, architectural decisions, things that look wrong but are intentional.]"
}
```

**Key principle:** `session_notes` is the most important field. Write what you wish you'd known at the start of this session. If a deployment failed, explain what was last deployed and whether the repo is ahead of production.

### Step 3: Write to Supabase

```sql
INSERT INTO gps_settings (key, value, updated_at)
VALUES ('portal_context', '<JSON string>', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
```

### Step 4: Update PORTAL_STATE.md if needed

If this session changed anything documented in PORTAL_STATE.md — completed a pending item, added a new file, changed a schema column — update the file to reflect reality. Keep it current. This file is the ground truth.

### Step 5: Confirm

Output:
```
✅ Portal context synced — [timestamp]
Current focus: [what you wrote]
[n] pending items recorded
PORTAL_STATE.md: [updated / unchanged]
```

---

## Mode B — Check for portal notifications (start of session or on-demand)

Run this at the start of a portal session, or when Alex says "any portal alerts?" or "what did the sweep flag?"

### Step 1: Read portal_notifications from Supabase

```sql
SELECT value FROM gps_settings WHERE key = 'portal_notifications';
```

### Step 2: Parse and display

The value is a JSON array of notification objects:

```json
{
  "id": "sweep-YYYYMMDD-HHMM-portal-n",
  "detected_at": "[ISO timestamp]",
  "trigger": "[What triggered this — e.g., 'Vercel failed deployment']",
  "email_subject": "[Original email subject]",
  "email_sender": "[Sender]",
  "severity": "high | normal",
  "sub_agent_action": "[What the sub-agent did, if anything]",
  "sub_agent_findings": "[What it found]",
  "resolved": false,
  "resolved_at": null
}
```

Display unresolved notifications clearly. For each, note: what triggered it, when, what the sub-agent did (if it ran), and what still needs Alex's attention.

### Step 3: After resolving

Mark each addressed notification as resolved:

```sql
UPDATE gps_settings
SET value = (
  SELECT jsonb_agg(
    CASE WHEN item->>'id' = '<notification-id>'
    THEN item || '{"resolved": true, "resolved_at": "<ISO timestamp>"}'::jsonb
    ELSE item END
  )
  FROM jsonb_array_elements(value::jsonb) AS item
)::text,
updated_at = NOW()
WHERE key = 'portal_notifications';
```

---

## Mode C — Sub-agent context load (called by sweep sub-agents)

When a sub-agent is spawned by the inbox sweep to fix a portal issue, it will start its prompt with: **"Load portal context before acting."** That means:

### Step 1: Read portal_context from Supabase
```sql
SELECT value FROM gps_settings WHERE key = 'portal_context';
```

### Step 2: Read PORTAL_STATE.md
```
/Users/alex.tremble/Documents/Claude/Projects/Tool Creation/PORTAL_STATE.md
```

### Step 3: Read the specific notification
```sql
SELECT value FROM gps_settings WHERE key = 'portal_notifications';
```
Find the unresolved notification this sub-agent was spawned to handle.

### Step 4: Act with context
Now fix the issue using everything you know about how this portal was built. Do not guess at architecture. Do not rebuild things that already exist. Check what's actually deployed vs. what's in the repo before making changes.

### Step 5: Write back findings
Update the notification record with `sub_agent_action` and `sub_agent_findings`. If the fix is complete and safe to confirm, set `resolved: true`. If Alex's manual confirmation is needed (e.g., environment variable changes, schema migrations), leave `resolved: false` and explain exactly what needs to happen.
