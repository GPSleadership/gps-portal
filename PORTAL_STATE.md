# GPS Leadership Portal — Complete State Document
**Last updated:** May 2026  
**Purpose:** This document is the authoritative reference for everything built in the GPS Leadership portal. Before making ANY changes to the portal, read this document in full. Do not rebuild, replace, or modify anything described here unless explicitly instructed by Alex Tremble.

---

## 1. What This Portal Is

The GPS Leadership portal is a client-facing coaching support system with two sides:

- **Coach portal** (`coach.html`) — Alex's dashboard for adding and managing clients
- **Client portal** (`client.html`) — where coaching clients access their 90-day plan and tools

The portal is hosted at **portal.gpsleadership.org**, deployed via **Vercel**, code lives in **GitHub** at `https://github.com/GPSleadership/gps-portal`, and client data is stored in **Supabase**.

---

## 2. Repository Structure

```
gps-portal/
├── client.html              # Client-facing portal (90-day plan, weekly check-in, resources)
├── coach.html               # Coach dashboard (add/manage clients, import, analytics)
├── vercel.json              # Routing + cron + CORS headers
└── api/
    ├── get-client.js        # Secure token lookup → returns client data using service role key
    ├── notify.js            # Email notifications (plan submitted, check-in, reminders, test)
    ├── send-reminders.js    # Weekly reminder cron (runs Mondays 2pm UTC)
    ├── reminder-calendar.js # ICS calendar file endpoint for Apple/Outlook
    ├── import-clients.js    # Bulk client import from Excel/CSV
    └── ask.js               # Secure Anthropic API proxy (live)
```

**vercel.json** currently contains:
- Route rewrites: `/client` → `client.html`, `/coach` → `coach.html`
- Cron: `/api/send-reminders` runs `0 14 * * 1`
- CORS headers on all `/api/` routes

**Vercel environment variables required:**
- `RESEND_API_KEY` — for all outbound email
- `RESEND_FROM_EMAIL` — sender address (noreply@portal.gpsleadership.org)
- `SUPABASE_SECRET_KEY` — service role key, used by get-client.js and import-clients.js
- `ANTHROPIC_API_KEY` — ✅ add in Vercel dashboard (Production + Preview)

---

## 3. Database Schema (Supabase)

### `clients` table — all current columns

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | Full name |
| email | text | |
| title | text | Job title |
| organization | text | |
| token | text | Unique portal access token |
| is_active | boolean | |
| is_archived | boolean | |
| diagnostic_report_url | text | Google Drive link |
| plan_submitted_at | timestamp | Set on Form B submit |
| allow_plan_edit | boolean | Coach unlocks to allow re-edit |
| timezone | text | Client-selected on first Form B |
| in_coaching_program | boolean | Default true — controls AI chatbot access |
| tp3_pillar | text | Trust / Proactivity / Productivity |
| goal_description | text | |
| goal_30_day | text | |
| goal_statement | text | 90-day goal statement |
| behavior_1 | text | Required (replaces start_behavior) |
| behavior_2 | text | Optional second behavior |
| start_behavior | text | Legacy — kept in sync with behavior_1 |
| metric_1_name | text | Required |
| metric_1_baseline | numeric | |
| metric_1_target | numeric | |
| metric_2_name | text | Optional |
| metric_2_baseline | numeric | |
| metric_2_target | numeric | |
| metric_3_name | text | Optional |
| metric_3_baseline | numeric | |
| metric_3_target | numeric | |
| metric_name | text | Legacy — kept in sync with metric_1_name |
| metric_baseline | numeric | Legacy |
| metric_target | numeric | Legacy |
| metric_current | numeric | Updated each check-in |
| plan_start_date | date | |
| reward_30_day | text | Optional |
| reward_90_day | text | Optional |
| industry | text | Trucking / Parts & Service / Logistics / Industrial Services / Government / Other |
| revenue_band | text | <$10M / $10–25M / $25–50M / $50–100M / $100M+ |
| num_locations | text | 1 / 2–4 / 5–10 / 10+ |
| regions_owned | text | Free text |
| direct_reports_count | integer | |

### `checkins` table — all current columns

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| client_id | uuid | FK to clients |
| week_number | integer | 1–12 |
| attended_coaching | boolean | |
| completion_status | text | Yes / Partially / No |
| metric_value | numeric | Metric 1 current value |
| metric_2_value | numeric | Metric 2 current value (if defined) |
| metric_3_value | numeric | Metric 3 current value (if defined) |
| behavior_1_note | text | Client note on Behavior 1 |
| behavior_2_note | text | Client note on Behavior 2 (if defined) |
| planned_action | text | This week's commitment |
| notes | text | Reflection / anything for Alex |
| submitted_at | timestamp | |

### `coach_settings` table

| Column | Type | Notes |
|--------|------|-------|
| key | text | Setting name |
| value | text | Setting value |
| updated_at | timestamp | |

Seeded with: `coach_password`, `pending_code`, `pending_code_expires`

### RLS Status
All three tables have RLS enabled with permissive anon policies. Client portal reads go through `api/get-client.js` (service role key) for isolation.

---

## 4. The Q&A Tool — What It Is

A fully built AI-powered leadership Q&A tool ready to be integrated as a tab inside the client portal. Clients ask leadership questions in natural language and receive answers grounded in Alex's GPS frameworks, voice, and tool library.

### Key features already built:
- **Conversational threading** — remembers last 4 exchanges for follow-up questions
- **35 GPS tools** — all wired with routing logic and Drive PDF links
- **Alex's voice** — trained on his email campaigns, LinkedIn posts, 45 Operating Principles, and 4 books
- **Industry framing** — answers use trucking/fleet/parts/service/logistics examples
- **Assess → Deliver → Sustain lens** — slows CEOs down before prescribing
- **Portal context injection** — ready to receive client data and personalize every answer
- **Two-section response** — "Guidance for You" + "Suggested Next Step"
- **Coaching boundary** — tool knows when to hand off to Alex vs. self-serve
- **Escalation logic** — flags high-stakes situations (firing, legal, partnership conflicts) for live coaching
- **Crisis safety intercept** — HARDCODED (not AI-dependent). Detects crisis language BEFORE any API call. Shows 988, Crisis Text Line, and 911 resources immediately. Never bypasses. Never relies on AI.
- **Thumbs up/down feedback** — with optional open comment on thumbs down
- **20 questions/day limit** — soft guardrail with daily reset, amber/red counter
- **Fuzzy tool link matching** — handles minor tool name variations gracefully
- **4-layer JSON parse recovery** — never throws a raw error to the user
- **in_coaching_program gate** — only clients with this flag active can access the chatbot

### What the Q&A tool does NOT do:
- It does not recommend a new diagnostic ON the portal user (they've already done theirs)
- It does not do deep situational coaching (it flags those for Alex)
- It does not replace live coaching sessions

---

## 5. Integration Status

| Item | Status |
|------|--------|
| Q&A tool HTML/JS | ✅ Complete |
| Tool links (35 tools) | ✅ 33 linked, 2 pending (GPS Baseline Snapshot, CEO Financial Clarity Snapshot) |
| Portal context object | ✅ Built — fields defined, needs wiring to live client data |
| `api/get-client.js` | ✅ Live — replaces direct Supabase calls from client portal |
| `api/import-clients.js` | ✅ Live — bulk Excel/CSV import for coach dashboard |
| `api/ask.js` proxy | ✅ Live in repo |
| Anthropic API key in Vercel | ⏳ Alex to add when ready |
| Q&A tab in `client.html` | ✅ Integrated — tab shows when in_coaching_program = true |
| Drive PDF sharing permissions | ⏳ Alex to set "Anyone with link can view" on each PDF |
| in_coaching_program access gate | ✅ Built — toggle on coach dashboard per client |

---

## 6. Portal Context Object

When the Q&A tool is connected to the live portal, populate `portalContext` from the client record returned by `api/get-client.js`. Updated field list (includes new multi-behavior and multi-metric fields):

```javascript
const portalContext = {
  // From coach "Add Client" screen:
  full_name: "",
  email: "",
  role_title: "",           // maps to client.title
  organization: "",
  industry: "",             // "Trucking" | "Parts & Service" | "Logistics" | "Industrial Services" | "Government" | "Other"
  revenue_band: "",         // "<$10M" | "$10–25M" | "$25–50M" | "$50–100M" | "$100M+"
  num_locations: "",        // "1" | "2–4" | "5–10" | "10+"
  regions_owned: "",        // e.g. "TX/OK" or "Midwest"
  direct_reports_count: "", // integer

  // From their 90-Day plan:
  focus_pillar: "",         // "Trust" | "Proactivity" | "Productivity"
  goal_description: "",
  goal_30_day: "",
  goal_90_day_statement: "", // maps to client.goal_statement
  
  // Behaviors (use behavior_1/2 — fall back to start_behavior for legacy records)
  behavior_1: "",           // required
  behavior_2: "",           // optional, may be empty
  
  // Metrics (use metric_1_*/2_*/3_* — fall back to metric_name/baseline/target for legacy)
  metric_1_name: "",
  metric_1_baseline: "",
  metric_1_target: "",
  metric_2_name: "",        // may be empty
  metric_2_baseline: "",
  metric_2_target: "",
  metric_3_name: "",        // may be empty
  metric_3_baseline: "",
  metric_3_target: "",
  
  plan_start_date: "",
  reward_30_day: "",
  reward_90_day: ""
};
```

**Wiring example** (in `client.html` after `api/get-client.js` returns):
```javascript
portalContext.full_name           = client.name || "";
portalContext.role_title          = client.title || "";
portalContext.organization        = client.organization || "";
portalContext.industry            = client.industry || "";
portalContext.revenue_band        = client.revenue_band || "";
portalContext.num_locations       = client.num_locations || "";
portalContext.regions_owned       = client.regions_owned || "";
portalContext.direct_reports_count = client.direct_reports_count || "";
portalContext.focus_pillar        = client.tp3_pillar || "";
portalContext.goal_description    = client.goal_description || "";
portalContext.goal_30_day         = client.goal_30_day || "";
portalContext.goal_90_day_statement = client.goal_statement || "";
portalContext.behavior_1          = client.behavior_1 || client.start_behavior || "";
portalContext.behavior_2          = client.behavior_2 || "";
portalContext.metric_1_name       = client.metric_1_name || client.metric_name || "";
portalContext.metric_1_baseline   = client.metric_1_baseline ?? client.metric_baseline ?? "";
portalContext.metric_1_target     = client.metric_1_target ?? client.metric_target ?? "";
portalContext.metric_2_name       = client.metric_2_name || "";
portalContext.metric_2_baseline   = client.metric_2_baseline ?? "";
portalContext.metric_2_target     = client.metric_2_target ?? "";
portalContext.metric_3_name       = client.metric_3_name || "";
portalContext.metric_3_baseline   = client.metric_3_baseline ?? "";
portalContext.metric_3_target     = client.metric_3_target ?? "";
portalContext.plan_start_date     = client.plan_start_date || "";
portalContext.reward_30_day       = client.reward_30_day || "";
portalContext.reward_90_day       = client.reward_90_day || "";
```

---

## 7. Complete Tool Library with Drive Links

All 35 GPS tools with their current shareable Drive URLs. Tools marked `""` need PDFs uploaded to Drive and link added.

```javascript
const TOOL_LINKS = {
  // DIAGNOSTICS
  "14-Day Executive Leadership Diagnostic": "",
  "5 CEO Bottlenecks Scorecard":
    "https://drive.google.com/file/d/1Zg8Nwy0eYfe6CikpGXGIBja9zOWxMFFy/view?usp=drivesdk",
  "GPS Executive Leadership Scorecard":
    "https://drive.google.com/file/d/14R4sCyBq_yl9vzgOmsgvQ_rI8CR4x2Av/view?usp=drivesdk",
  "Executive Talent Snapshot (\"4 or Better\" Bar)":
    "https://drive.google.com/file/d/18ag5r5bkE0wq56j-iFmoAc9AvAPg-Dbd/view?usp=drivesdk",
  "GPS Baseline Snapshot": "",                    // ADD WHEN PDF UPLOADED
  "GPS Workforce Capability & Training Assessment":
    "https://drive.google.com/file/d/1_L9jxMqLYiCnf8VrSlgVFHWWDQ8bYMt7/view?usp=drivesdk",
  "Under-Pressure Communication Snapshot":
    "https://docs.google.com/document/d/1yVkUev5BgYn4879VA2ZfQGpyMjOa3DKZYVUiyn50jMg/edit?usp=drivesdk",

  // OPERATING SYSTEMS
  "Delegation Operating System (Delegation Audit + Brief)":
    "https://drive.google.com/file/d/1q89oxe_Affiv2iAmCdSijzrBcSqiiIP/view?usp=drivesdk",
  "Team Meeting Operating Standard":
    "https://drive.google.com/file/d/1Glgw8bk1hJJaW_aL-l8g2zLDZSdzZm7S/view?usp=drivesdk",
  "GPS 1-on-1 Alignment Guide":
    "https://drive.google.com/file/d/1-g41L7lgQ1vlkVfgqZ9MXhbY8WcZ5Fwl/view?usp=drivesdk",
  "Executive Alignment Quickstart":
    "https://drive.google.com/file/d/1tNXFsDhtXPx-dEhXXzPD3rlHi5HoDaDC/view?usp=drivesdk",
  "Time Alignment Blueprint™":
    "https://drive.google.com/file/d/1C477nB4mB8SBLmKzBYdddQmuMmMh_Cqx/view?usp=drivesdk",
  "Where I'm Spending Too Much Time (Time Leak Audit)":
    "https://drive.google.com/file/d/18AZI-xvFFLIwG7pjDCO_SEEZbxFPSTN5/view?usp=drivesdk",
  "Decision-Ready Communication Blueprint":
    "https://drive.google.com/file/d/1w2btHbZBqihAqUQzxrodzx1yt_O_Qle7/view?usp=drivesdk",
  "Decision-Ready Communication Quick Checklist":
    "https://drive.google.com/file/d/1BBKPQyDK7ZtpRjCYQ8jCg_NmtDy26EBj/view?usp=drivesdk",
  "GPS Program Management Readiness & Alignment Checklist":
    "https://drive.google.com/file/d/1ZkbS29IZeXvM9eTv0hef49Fmpbv7sVzb/view?usp=drivesdk",

  // CONVERSATION & FEEDBACK
  "GPS CLEAR Feedback Model":
    "https://drive.google.com/file/d/1twbHaL93IgtNM9fvhKh9fUlj61lDTtC1/view?usp=drivesdk",
  "Brave Conversation Blueprint":
    "https://docs.google.com/document/d/1vb9G3gGbnXNMv4uGZavfl3j8e7e3cv_csl9-DC_op34/edit?usp=drivesdk",
  "Trust Accelerator™ Conversation":
    "https://drive.google.com/file/d/1WyZlDZR0CWv4N_Vs1UuSgZuu_WAk0kKn/view?usp=drivesdk",
  "Under-Pressure Communication Playbook":
    "https://docs.google.com/document/d/17YUeqGFd4rkiWHo2HGojf_smWLNW8dAUjjKw3-NZZyg/edit?usp=drivesdk",
  "Executive Speaking Playbook":
    "https://drive.google.com/file/d/1VUT3LDGUXASZRUI-ipMYcgHWkWu3rwE2/view?usp=drivesdk",
  "Extended Speaking Guide (Boardroom Buy-In)":
    "https://drive.google.com/file/d/1Vb3Qd4iOi8LRJsljNnUdFy0gUDmmQQWe/view?usp=drivesdk",
  "GPS Speak with Impact Workbook":
    "https://drive.google.com/file/d/1EmGDdrOjvPdTb-K7ZWsARmUSzD0rVKp1/view?usp=drivesdk",

  // PEOPLE, TALENT & RELATIONSHIPS
  "Own the Outcome™ Personal Accountability Reset":
    "https://drive.google.com/file/d/1ahvRp_XfKHWi1k-IZJDkVKV8L_zQmeMu/view?usp=drivesdk",
  "Own the Outcome™ Mentor Exercise":
    "https://drive.google.com/file/d/1qptm8kaki8ncVgcsHzGaeImEMhKE3uts/view?usp=drivesdk",
  "Executive Performance Conversation Prep Guide":
    "https://drive.google.com/file/d/1YlKqXIFcSe06bRtVRGFen7n7vkoA45_0/view?usp=drivesdk",
  "Executive 360 Connection Conversation Guide™":
    "https://drive.google.com/file/d/1LK4ntbSdWQ_3iCdL_hn1svQOdCeCC-P1/view?usp=drivesdk",
  "Executive Relationship Matrix":
    "https://drive.google.com/file/d/1vh5vGtS0S6G8skQ4D9jCId6uCcTcNCuX/view?usp=drivesdk",
  "Executive Influence Alignment Map":
    "https://drive.google.com/file/d/1brxQ60FCow0OXr4utZUGV_1ZUwW2iwaA/view?usp=drivesdk",
  "Manager–Employee Relationship Reset":
    "https://drive.google.com/file/d/1oqsMSuQuohL4F415QbdjjIVAtDs2_M86/view?usp=drivesdk",

  // ALIGN KIT
  "GPS Alignment Blueprint (Six Coordinates)":
    "https://drive.google.com/file/d/1Aci0rG3C5_2dHBemnxw-O9MepNKxs5p3/view?usp=drivesdk",
  "GPS Strategic Working Agreements Worksheet":
    "https://drive.google.com/file/d/1wXpeAMWOq_VUIBqep5hl0i8vFJMSzHKV/view?usp=drivesdk",

  // EMBED KIT
  "90-Day Leadership Impact Plan":
    "https://drive.google.com/file/d/1P5mqXp3QKYYW22QVsGJXmBwOSh6yF1lW/view?usp=drivesdk",
  "90-Day Mentoring Partnership Plan":
    "https://drive.google.com/file/d/1oFwq97P5b-VEZxcXv60lD5752mUFZApK/view?usp=drivesdk",
  "Executive Coaching Questions GROW Guide":
    "https://drive.google.com/file/d/1647RZln3UgdTsZCOCHlvkq2w0N7MCkoD/view?usp=drivesdk",

  // LIFE & CAREER
  "Executive Life & Career Trajectory Blueprint":
    "https://drive.google.com/file/d/1XwJxL8xuDd330vi02CyuOYQgmPwdvN11/view?usp=drivesdk",
  "CEO Financial Clarity Snapshot": ""            // ADD WHEN PDF UPLOADED
};
```

---

## 8. New File to Add: `api/ask.js`

Create this file at `api/ask.js` in the repo. This is the secure API proxy that keeps the Anthropic API key server-side.

```javascript
// api/ask.js
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, system } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages
      })
    });

    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
```

**After adding this file**, add the environment variable in Vercel:
- Name: `ANTHROPIC_API_KEY`
- Value: Alex's key from console.anthropic.com
- Environment: Production and Preview

---

## 9. How to Integrate the Q&A Tool into `client.html`

### Step 1 — Add a new tab to the navigation
Find the existing tab navigation in `client.html` and add an "Ask a Question" tab.

### Step 2 — Add the Q&A section
Add a new section/panel for the Q&A tool that shows when the tab is active.

### Step 3 — Inject portal context
After `api/get-client.js` returns, populate `portalContext` using the wiring example in Section 6.

### Step 4 — Switch API endpoint
In the Q&A tool's `send()` function, change the fetch URL from the direct Anthropic call to:
```javascript
const res = await fetch('/api/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    system: buildSystemPrompt(portalContext),
    messages: conversationHistory
  })
});
```

### Step 5 — Add access gate
Before showing the Q&A tab, check `client.in_coaching_program`. If false, hide the tab entirely.

### Step 6 — Remove the sandbox badge
Change the header badge from `Sandbox — Not Live` to nothing (or `Beta`) once live.

> **IMPORTANT:** The complete Q&A tool code is in `gps_qa_sandbox.html`. Use that file as the source. The notes above describe the only changes needed.

---

## 10. Crisis Safety System — DO NOT MODIFY

The crisis safety intercept is hardcoded in the Q&A tool JavaScript. It runs **before** any API call. It detects phrases related to self-harm, suicide, and harming others. When triggered, it immediately shows three crisis resources (988, Crisis Text Line, 911) and a legal disclaimer. **This system must never be removed, disabled, or made AI-dependent.**

Current crisis phrases detected (case-insensitive):
`ending my life`, `end my life`, `kill myself`, `want to die`, `want to end it`, `suicidal`, `suicide`, `don't want to live`, `don't want to be here anymore`, `thinking about ending`, `hurt myself`, `harm myself`, `self harm`, `self-harm`, `hurt someone`, `kill someone`, `hurt others`, `harm others`, `not worth living`, `life isn't worth`, `life is not worth`, `can't go on`, `cannot go on`, `giving up on life`, `no reason to live`

---

## 11. Separation of Concerns — Which Thread Does What

| Task | Use This Thread |
|------|----------------|
| Portal UI changes (layout, new sections, client data fields) | Cowork thread |
| Q&A tool voice, frameworks, tool routing, system prompt | Separate Claude chat thread |
| Adding new tool links when PDFs are uploaded | Separate Claude chat thread |
| Wiring portalContext into client.html | Cowork thread (using Section 6 above) |
| Adding `api/ask.js` to repo | Cowork thread (copy code from Section 8) |
| Adding Anthropic API key to Vercel | Alex does directly in Vercel dashboard |

---

## 12. Pending Items (in order)

1. Test multi-behavior and multi-metric Form B with a new client
2. Test Excel import with a small roster file
3. Test `in_coaching_program` toggle on coach dashboard
4. Confirm existing client portal links still load correctly (now routed via `api/get-client.js`)
5. Alex uploads GPS Baseline Snapshot PDF to Drive → send link to Q&A thread to wire in
6. Alex uploads CEO Financial Clarity Snapshot PDF to Drive → same
7. Alex confirms all Drive PDFs set to "Anyone with the link can view"
8. Alex gets Anthropic API key from console.anthropic.com (when ready to go live)
9. ✅ `api/ask.js` added to repo
10. Add `ANTHROPIC_API_KEY` to Vercel environment variables (Production + Preview)
11. ✅ Q&A tab integrated into `client.html`
12. ✅ `in_coaching_program` access gate wired — tab hidden if false
13. Test end-to-end with one real client before broader rollout

---

## 13. How to Use This Document in Cowork

Paste the following at the start of any new Cowork conversation before making portal changes:

> "Before making any changes, read this document carefully. It describes everything built so far in the GPS Leadership portal. Do not rebuild, replace, or modify anything described here unless Alex explicitly asks for it. The Q&A tool (Section 9) is complete and should only be modified by following the integration steps in Section 9."

Then paste the full content of this document.
