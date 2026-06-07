# TP3 Organizational Assessment — V2 Build Spec
**Status:** Approved by Alex, queued as next portal sprint (captured June 6, 2026)
**Run with:** `/gps-portal-safe-build` · Read `PORTAL_STATE.md` (esp. Section 16) first.

## Current-state notes for the build session (read before implementing)
- The Workshop & Assessment module (v35–v39) is LIVE on `main`. `engagement_kind` ('workshop'|'assessment'), `summary_approved` publish gate, `room_survey_token` QR, discovery transcript box, editable sponsor report, and the Decision-Room-styled `workshop-room.html` all exist — build on them, don't rebuild.
- There is NO Organization entity yet — `workshops.client_org_name` is free text and `clients.organization` is free text. Part 0 creates it (next migration: **v40**).
- Logo storage: use a Supabase Storage bucket (mirror the `diagnostic-reports` bucket pattern; prefer private + signed or public-read like the existing one — match v23 conventions).
- XLSX both directions: SheetJS from cdnjs is the house pattern (client-side parse for roster upload; for "Export full Excel," generate client-side with SheetJS in coach.html from an endpoint's JSON payload).
- Standard question templates live in `workshop_questions` with `workshop_id NULL`. Part 3 replaces the assessment seed with the new 21-question bank — keep the existing workshop pre/post templates separate (scope the new bank to assessments, e.g. a `template_set` column or seed-per-assessment on create).
- Participants are `clients` rows (one profile per person, `is_workshop_participant` flag) — Part 4's "no portal accounts" is already true (they have no portal token/coaching access); keep that model.
- Coach session auth: `coachData()`/`wsData()` wrappers in coach.html; generic table proxy allowlist in `api/coach-data.js` (add `organizations` to it).
- `check.sh`: coach.html escaped-backtick baseline = 0. Never put SVG/complex content in JS template literals.

---

## THE SPEC (verbatim from Alex)

You are building and refining the TP3 Organizational Assessment workflow inside the GPS Leadership Solutions Coach Dashboard and Sponsor Dashboard.

OBJECTIVE
Make the TP3 Organizational Assessment flow match how coaches actually work:
- Organization accounts that track all work, people, and branding per company.
- Fast assessment setup with the right required fields.
- Standard TP3 question bank (quant + rich qual, including bottleneck and consequence) plus optional AI-generated custom questions.
- Simple roster management with CSV/XLSX, resend logic, and no portal accounts for participants.
- Clean sponsor view with org logo.
- Strong export and recap email tooling so coaches can write reports externally and then upload them.

PART 0: ORGANIZATION ACCOUNTS
Create an Organization entity (if it does not already exist) with at least:
- id
- name
- industry
- size_band
- tags
- logo_url
- notes (internal)
- created_at / updated_at

Relationships:
- One Organization → many Engagements (workshops, assessments, diagnostics).
- One Organization → many Contacts (sponsors, leaders, etc.).

Behavior:
- When a coach enters "Client / organization" on the assessment form, allow selecting an existing Organization via typeahead OR creating a new one.
- From the Clients/Organizations area, the coach can open an Organization detail page that shows:
  - Org info + logo
  - All engagements with that org
  - All sponsor/leader contacts tied to that org

Org logo:
- Stored once on the Organization (logo_url) and reused on:
  - All sponsor dashboards for that org
  - All participant surveys for that org
  - Any reports that render org branding

PART 1: NEW ASSESSMENT CREATION
Update the "New TP3 Organizational Assessment" form:

Required fields:
- Title
- Client / organization (select or create Organization)
- Debrief date
- Sponsor / leader name
- Sponsor / leader email

Optional fields:
- Industry
- Audience level (Executive, Manager, Mixed, N/A)
- Company size band
- Internal tags
- Company logo upload (PNG/JPG, max 5 MB, wide aspect). If provided, update the Organization's logo_url.

Behavior:
- Selecting/creating Client / organization links the assessment to that Organization.
- Logo uploaded here is saved on the Organization and reused automatically.

PART 2: TABS & OVERVIEW
Reorder tabs for assessments to: Overview → Questions → Roster → Data → Recap.

Overview:
- Status & Debrief info
- Sponsor dashboard link
- Discovery call notes / transcript:
  - Large text box for pasted notes.
  - File uploader for discovery attachments (PDF, DOCX, TXT).
  - AI must be able to use BOTH the text box content and attached files when:
    - Suggesting extra questions (Questions tab, "AI suggest from discovery").
    - Drafting exec summary and recap email.

PART 3: QUESTIONS TAB
Seed every new TP3 Organizational Assessment with the following base questions.

Scale questions (1–5, Strongly disagree → Strongly agree), except NPS:

TRUST
1. I trust our senior leaders to follow through on the commitments they make.
2. People can raise concerns or bad news here without fear of punishment.
3. Leaders explain the "why" behind important decisions clearly enough.
4. Teams and departments treat each other with respect, not blame.

PROACTIVITY
5. People take ownership instead of waiting to be told exactly what to do.
6. We raise issues early, before they turn into emergencies.
7. Decisions are usually made at the right level without always needing top approval.
8. When priorities change, leaders clearly reset expectations and tradeoffs.

PRODUCTIVITY / EXECUTION
9. Our top priorities for the next 90 days are clear to me.
10. Most meetings lead to clear decisions, owners, and next steps.
11. High-value work is not constantly derailed by low-impact urgent requests.
12. Cross-functional projects move at the speed they should in our organization.

OVERALL
13. Overall, our organization executes effectively on its most important goals.

NPS
14. How likely are you to recommend this organization as a great place to work? (0–10)

STANDARD QUALITATIVE QUESTIONS (open text):
15. START: What is one thing we should START doing to increase trust, proactivity, or productivity in this organization over the next 6–12 months?
16. STOP: What is one thing we should STOP doing because it reduces trust, proactivity, or productivity?
17. CONTINUE: What is one thing we should CONTINUE or double down on because it already builds trust, proactivity, or productivity here?
18. ADVICE TO LEADERS: If you could give senior leaders one piece of advice to improve how we work together, what would it be?

BOTTLENECK & CONSEQUENCE SPINE:
19. BIGGEST BOTTLENECK (single choice): "Of the three areas below, which is currently the biggest bottleneck in your part of the organization? (Pick one.)"
   - Trust (how much we can rely on each other and our leaders)
   - Proactivity (ownership, raising issues early, taking initiative)
   - Productivity (clarity, meetings, and how fast work actually moves)
   - They're roughly equal
   - I'm not sure
20. WHY THAT BOTTLENECK: "In a sentence or two, what makes you say that is the biggest bottleneck right now? Please give a recent example if you can."
21. COST OF NOT CHANGING: "If we do NOT improve how we work together over the next 12–24 months, what do you think the biggest risk or cost will be for the organization (for customers, revenue, safety, or people)?"

Behavior:
- Base TP3 questions + qualitative + bottleneck spine are automatically added for each new TP3 Organizational Assessment.
- Coach can turn individual questions or sections on/off but cannot accidentally delete the master template.

Demographic questions (coach-toggleable per assessment):
- Name (text)
- Email (text)
- Job title (text)
- Management level (Executive / Director / Manager / Individual contributor / Frontline hourly / Other)
- Department / function
- Primary location / site
- Tenure at organization (0–1 yr / 1–3 / 3–5 / 5–10 / 10+)
- People manager? (Yes/No, with optional # of direct reports)

AI-suggested custom questions:
- Button: "AI suggest from discovery".
- Use discovery notes + attachments + Organization info to propose 5–6 extra questions.
- The mix MUST include:
  - At least 2 additional scale questions (1–5) tailored to the client's context.
  - At least 2 additional qualitative questions that are behavior-focused (e.g., "Describe a recent situation where…").
- Show proposed questions in a review list where the coach can:
  - Approve as-is
  - Edit wording
  - Delete
- Only approved questions are added to the live survey.

PART 4: ROSTER TAB
Keep Shared survey link + QR.

Roster:
- CSV paste/upload with header: name,email,role,location,department
- Add Excel (.xlsx) upload with the same logical columns.
- Allow attaching the original roster file for reference (stored as a document on the assessment).

Participants table:
- After successful import, auto-populate Participants count.
- Each row shows: Name, Email, Role, Department, Status.
- Status: Not sent, Sent, Completed, Reminder sent.
- Buttons:
  - "Send survey (email)" → sends to all Not sent participants.
  - Per-row "Resend survey" → sends a reminder email to that participant.

Important:
- Roster participants do NOT get portal user accounts; they are assessment-only contacts.

PART 5: DATA TAB
Keep:
- Compute indices
- Export participant CSV
- Export sponsor summary
- Export GHL fields

Add:
- "Export full Excel" including:
  - All response data by participant and question (scale + qualitative).
  - Demographic fields used.
  - Organization name, industry, size band.
  - Sponsor name/email.
  - Debrief date, audience level, internal tags, assessment title.
  - Reference to discovery notes (e.g., raw text column).

Sample data (demo only):
- Add a boolean flag on assessments: is_demo.
- On demo assessments only, show "Generate sample data".
- This button generates fake responses across all active questions for testing coach and sponsor views.
- Never allow this on non-demo assessments.

PART 6: RECAP TAB & EMAIL
Recap tab keeps:
- Sponsor report area for strengths, risks, 90-day focus, recommended next step.
- "Generate exec summary" and "Generate recommendation".

Post-debrief recap email:
- Add "Draft recap email" button.
- AI uses:
  - Computed metrics (TP3, NPS, response rate).
  - Saved strengths, risks, 90-day focus.
  - Debrief notes/transcript (pasted + files).
  - Recommended next step.
- Show email in editable text area.
- Coach can edit then click "Send recap to sponsor".

Email content structure:
- Short thank you and reference to the debrief.
- Key metrics (TP3, NPS, response rate).
- 2–3 strengths and 2–3 risks (bullets).
- Agreed 90-day focus.
- Link to sponsor dashboard.
- CTA for 14-Day Executive Leadership Diagnostic.

PART 7: SPONSOR DASHBOARD & BRANDING
Sponsor view:
- Display Organization logo next to GPS logo in header.
- Show live TP3 / NPS / response rate / participants.
- When sponsor report is "published," show strengths, risks, 90-day focus, and recommended next step.
- When not published, show only metrics and a "being finalized" note.

Participant survey:
- Show Organization logo next to GPS logo if available.
- If no logo, center GPS branding and do not show empty placeholders.

PART 8: WORKSHOPS & ASSESSMENTS LIST
On the main Workshops & Assessments list:
- For each row, add actions:
  - Archive engagement (moves from active to archived list).
  - Delete engagement (with confirmation; permanent removal of that engagement's data).

DEFINITION OF DONE
- Organization accounts track all engagements, people, and logos.
- Coach can:
  - Create assessments with all required client/sponsor details.
  - Use a base TP3 question set (quant + qual + bottleneck spine) and layer on AI-suggested custom questions.
  - Manage rosters via CSV/XLSX, send to all, and resend to individuals.
  - Export a comprehensive Excel for external analysis.
  - Generate realistic demo data.
  - Draft and send a high-quality, post-debrief recap email.
  - Archive or delete engagements.
- Sponsor sees a clean dashboard with their logo, live metrics, and your finalized narrative when published.
