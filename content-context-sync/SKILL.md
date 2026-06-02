---
name: content-context-sync
description: Syncs the GPS Leadership content and automation system's working state to Supabase so that sweep sub-agents can load context before investigating Make.com or GoHighLevel issues. Use this skill at the END of any session working on GPS weekly content, GHL automations, Make.com scenarios, social media pipelines, or AI content workflows. Trigger on: "sync content context", "save content state", "update content context", "record what we built in GHL", or any session that modifies Make.com scenarios, GoHighLevel workflows, or the content automation pipeline. Also run at the START of a content session to check for alerts the inbox sweep left in content_notifications.
---

# Content Context Sync

You are managing the GPS Leadership content and automation system's shared memory. This system connects Claude/AI → Make.com → GoHighLevel (GHL) to produce and distribute Alex Tremble's weekly leadership content across social media and email channels.

The Supabase project is `pbnkefuqpoztcxfagiod` (same database as the GPS portal — different keys).

---

## Supabase credentials

Both fields use the same token:
```
apikey / Bearer: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibmtlZnVxcG96dGN4ZmFnaW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5OTkwMzEsImV4cCI6MjA5MjU3NTAzMX0.DxEMR2Ckt9QJlRMkFenEZn-gzsVoi8-6CFcAItTePjo
```

Use the Supabase MCP (`execute_sql`, project ID: `pbnkefuqpoztcxfagiod`) for all reads and writes. Table: `gps_settings` (key, value, updated_at).

---

## What "content system" means

When you first run this skill, the content_context snapshot will be empty or minimal — that's expected. The context grows richer each session as you document what's been built. Start with what you know:

- Which Make.com scenarios exist and what each one does
- How GHL is connected (API key, sub-account, pipeline names)
- What content gets generated (LinkedIn posts, emails, social captions, etc.)
- The weekly cadence and any scheduled automations
- Known fragile spots or things that require manual attention

Over time this becomes the equivalent of `PORTAL_STATE.md` for the content system.

---

## Mode A — Write context snapshot (end of session)

Run at the end of any content/automation working session.

### Step 1: Gather what you know

Collect from this session and any documentation available:
- What Make.com scenarios exist, their names, what triggers them, what they do
- How GHL is connected and what it receives
- What was changed or built this session
- Any known issues, fragile webhooks, or manual steps required

### Step 2: Read existing content_context (if any)

```sql
SELECT value FROM gps_settings WHERE key = 'content_context';
```

Merge your new session knowledge with what's already there. Don't overwrite good existing documentation — add to it.

### Step 3: Build the snapshot

```json
{
  "last_updated": "[ISO timestamp]",
  "updated_by": "content-session",
  "system_description": "Make.com + GoHighLevel + Claude/AI content pipeline for GPS Leadership weekly content and social media",
  "make_scenarios": [
    {
      "name": "[Scenario name as it appears in Make.com]",
      "trigger": "[What starts it — webhook, schedule, manual]",
      "what_it_does": "[Plain English description]",
      "connected_to": "[GHL / Gmail / LinkedIn / etc.]",
      "status": "active | paused | broken"
    }
  ],
  "ghl_connection": {
    "sub_account": "[GHL sub-account name]",
    "connected_via": "Make.com API key",
    "pipelines_used": ["list of GHL pipeline names used"],
    "content_types": ["LinkedIn posts", "email", "SMS", "social captions"]
  },
  "weekly_cadence": "[Description of the content schedule — e.g., Monday LinkedIn post, Wednesday email]",
  "current_focus": "[What this session was working on]",
  "files_modified": ["any relevant files or Make.com scenario names changed"],
  "known_issues": ["fragile webhooks, manual steps, things that break easily"],
  "session_notes": "[Anything a sub-agent must know before touching this system. What's intentional vs. broken. What NOT to change.]"
}
```

**`session_notes` is the most important field.** If a Make.com scenario just errored, explain what was last working and what changed. If there's a webhook URL that needs to stay fixed, say so.

### Step 4: Write to Supabase

```sql
INSERT INTO gps_settings (key, value, updated_at)
VALUES ('content_context', '<JSON string>', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
```

### Step 5: Confirm

```
✅ Content context synced — [timestamp]
Current focus: [what you wrote]
Make.com scenarios documented: [n]
KNOWN ISSUES: [list or "none"]
```

---

## Mode B — Check for content notifications (start of session or on-demand)

Run at the start of any content/GHL session, or when Alex says "any content alerts?" or "what did the sweep flag for content?"

### Step 1: Read content_notifications

```sql
SELECT value FROM gps_settings WHERE key = 'content_notifications';
```

### Step 2: Display unresolved notifications

Each notification looks like:
```json
{
  "id": "sweep-YYYYMMDD-HHMM-content-n",
  "detected_at": "[ISO timestamp]",
  "trigger": "[What triggered — e.g., 'Make.com: GPS Diagnostic Social Accounts scenario stopped']",
  "email_subject": "[Original email subject]",
  "email_sender": "[Sender]",
  "severity": "high | normal",
  "route": "content | ambiguous",
  "sub_agent_action": "[What the sub-agent did, or null]",
  "sub_agent_findings": "[What it found, or null]",
  "resolved": false,
  "resolved_at": null
}
```

Show each unresolved notification. Note: what triggered it, when, what the sub-agent already tried, and what still needs attention.

### Step 3: After resolving

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
WHERE key = 'content_notifications';
```

---

## Mode C — Sub-agent context load (called by sweep sub-agents)

When the inbox sweep detects a Make.com or GHL error and spawns a sub-agent, the sub-agent begins by loading this context.

### Step 1: Read content_context
```sql
SELECT value FROM gps_settings WHERE key = 'content_context';
```

### Step 2: Read the unresolved notification
```sql
SELECT value FROM gps_settings WHERE key = 'content_notifications';
```
Find the specific unresolved item this sub-agent was spawned to handle.

### Step 3: Act with context

Use what you know about the Make.com + GHL setup to diagnose and fix the issue. Do not guess at scenario names or webhook URLs — work from what's documented in `content_context`. If the context snapshot is empty or minimal, note that in your findings and recommend Alex run a content session to document the system before sub-agents can act reliably.

### Step 4: Write back findings

Update the notification with `sub_agent_action` and `sub_agent_findings`. Set `resolved: true` only if the fix is confirmed. If Alex must take a manual step (e.g., re-enable a Make.com scenario, update a webhook URL in GHL), leave `resolved: false` and be specific about what needs to happen.

---

## Note on the first sync

The first time you run Mode A, `content_context` will be empty. That's fine — build the snapshot from what you know in the current session. Even a partial snapshot (two or three Make.com scenarios documented) is dramatically better than nothing for a sub-agent trying to fix a 3am error. Prioritize: scenario names, what triggers them, and any known fragile spots.
