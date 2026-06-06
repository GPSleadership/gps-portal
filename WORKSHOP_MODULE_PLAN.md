# Workshop Module — Build Plan

**Status:** Awaiting approval to build
**Branch:** `workshop-module` (off clean `main`)
**Migration:** starts at `v35` (schema is at v34)
**Architecture:** matches the post-v26 security model — no anon key, all data through token/session-validated serverless endpoints using the service-role key, RLS deny-all to anon as backstop. Single-file vanilla HTML/CSS/JS, no build step. Vercel **Pro** (no function-count cap). Resend for email, Anthropic for AI.
**Closest analog already in the repo:** the Decision Room (`decision-room.html` + `api/sponsor-data.js`). The workshop sponsor dashboard mirrors it.

---

## 1. Guiding decisions

- **One profile per person.** Every participant and sponsor is a single `clients` row (their unified identity). Workshop-specific data lives in standalone `workshop_*` tables; people link in via join tables. Workshop-only people are flagged so they never clutter the coaching-client list. Stacking a diagnostic or coaching engagement later reuses the same profile.
- **Standalone workshop tables** for the distinct lifecycle, **reuse** `testimonials` / `referrals` (right shape already) and the Resend email + sponsor-token endpoint patterns.
- **The endpoint is the security gate**, never page JS, never RLS. Confidential/gated data is *omitted server-side*, not hidden in the UI.
- **Build whole module on one branch, test once** end-to-end on the preview, then cutover.

---

## 2. Schema (migration `v35-workshop-module.sql` — additive, RLS enabled, no anon policies, with ROLLBACK block)

### New tables

**`workshops`** — the engagement record
- `id` uuid pk, `created_at`, `updated_at`, `is_archived` bool
- `client_org_name` text, `title` text
- `workshop_date` date, `debrief_date` date
- `sponsor_client_id` uuid → `clients(id)` (the sponsor/leader profile)
- `industry` text, `company_size_band` text, `audience_level` text (`executive`|`manager`)
- `tags` text[] (internal: e.g. trucking, federal, parts & service)
- `status` text — lifecycle (see §3)
- `pre_survey_open_at`, `pre_survey_close_at`, `post_survey_open_at`, `post_survey_close_at` timestamptz
- `sponsor_token` text unique (dashboard access link)
- `confidentiality_mode` text default `standard` (`standard`|`private`) — future-proofing, mirrors DR
- `discovery_notes` text, `discovery_transcript` text
- `exec_summary_json` jsonb (computed: participation, NPS, TP3 snapshot, top strengths/risks, 90-day focus)
- `recommendation_json` jsonb (rules-engine output: recommended next GPS step + rationale)
- `bonus_resource_config` jsonb (per-workshop locked asset for promoters)

**`workshop_participants`** — person ↔ workshop link
- `id` uuid pk, `workshop_id` → `workshops`, `client_id` → `clients` (unified profile)
- `role` text, `location` text, `department` text
- `participant_token` text unique (survey access + magic resume link)
- `pre_status` / `post_status` text (`not_started`|`in_progress`|`complete`)
- `invited_at`, `pre_completed_at`, `post_completed_at`, `email_bounced` bool

**`workshop_questions`** — question bank (templates + per-workshop)
- `id` uuid pk, `workshop_id` (nullable = global standard template)
- `question_id` text (stable), `question_theme` text (trust, proactivity, productivity, delegation, meetings, communication…)
- `phase` text (`pre`|`post`), `question_text` text
- `response_type` text (`numeric`|`scale`|`text`), `scale_min`/`scale_max` int, `version` int
- `source` text (`standard`|`custom`|`ai_suggested`), `status` text (`draft`|`approved`|`live`)
- `sort_order` int, `created_at`

**`workshop_responses`** — the response store (matches your requested schema)
- `id` uuid pk, `workshop_id`, `participant_id` → `workshop_participants`, `sponsor_id` (nullable)
- `question_id`, `question_text`, `question_theme`, `phase`
- `response_value` numeric (nullable), `response_text` text (nullable), `created_at`

### Reused tables (small additive columns)
- **`testimonials`** — add nullable `workshop_id`. New `source` values: `workshop_debrief`. Existing `responses` jsonb, `rating_nps`, `permission_public_use` reused as-is.
- **`referrals`** — add nullable `workshop_id` for attribution. Existing pipeline reused.
- **`clients`** — add `is_workshop_participant` bool default false (keeps workshop-only people out of the coaching list; the dashboard filters on it). No other changes.

### Benchmarks
Portfolio averages (by industry / size / level) computed in the endpoint at first (small N). A materialized `workshop_benchmarks` table is a fast-follow once data volume justifies it.

---

## 3. Workshop lifecycle (drives the sponsor timeline + status)

`setup → discovery_complete → questions_drafted → sponsor_review → pre_survey_open → pre_survey_closed → workshop_delivered → post_survey_open → post_survey_closed → debrief_scheduled → report_uploaded → complete`

The sponsor dashboard timeline renders exactly these milestones with the current one highlighted and the next milestone + countdown (to workshop date, to survey close, to debrief).

---

## 4. Endpoints (new `api/*.js` — Pro plan, no cap)

- **`api/workshop-data.js`** — coach-session-gated. `?action=` routing (mirrors `diagnostic.js`): `create`, `update`, `upload-roster` (CSV/xlsx parse → create `clients` + `workshop_participants`), `list`, `get`, `questions-crud`, `suggest-questions` (AI, coach-approves), `generate-post-questions` (AI from pre data), `aggregate` (indices/deltas), `export-participant-csv`, `export-sponsor-csv`, `generate-summary` (AI exec summary), `recommend` (rules engine), `send-recap`, `reminders` (cron).
- **`api/workshop-survey.js`** — token-gated participant survey: load (themed page groups, prefill known fields), submit (per-page save), `save-and-resume` magic link. Mirrors `survey.js` / `diag-portal.js`.
- **`api/workshop-sponsor.js`** — sponsor-token-gated read-only dashboard payload. Server-assembles exec summary, timeline, response rates, recommendations. The single security boundary (mirrors `sponsor-data.js`). Confidentiality stripping if `private`.
- **Email** — add workshop types to `api/notify.js`: `workshop_survey_invite`, survey cadence nudges, `workshop_recap`. Reuse the Resend `sendEmail()` pattern.
- **Cron** — daily workshop reminder run (folded into `workshop-data.js?action=reminders`): day-1 open, 3 days before close, 1 day before, morning of close. Added to `vercel.json` crons.

---

## 5. Pages

- **Coach: new "Workshops" tab in `coach.html`** (mirrors the Diagnostics tab). Setup form (org, title, dates, sponsor, industry/size/level, tags), roster upload, question management (standard set + add custom + AI-suggest with approve gate, separate pre/post sets), live response-rate tracking, indices view, exports, recommendations, "Send recap" button.
- **Sponsor: new `workshop-room.html`** at `/workshop-room?token=…` — read-only. Exec summary card (participation pre/post, NPS, pre-vs-post TP3 snapshot, 3 bullets: strengths/risks/90-day focus), live timeline, recommendations section (findings tied to themes + best next GPS step, framed as "fastest way to fix what the data shows"). Token-gated; sponsor reaches it from their single profile.
- **Participant: new `workshop-survey.html`** at `/workshop-survey?token=…` — mobile-first. Time estimate, progress bar ("X of Y"), theme-grouped short pages, prefilled known fields hidden once done, save-and-resume via magic link.
- **`vercel.json`** — add `/workshop-room` and `/workshop-survey` rewrites + the reminder cron.

---

## 6. Data, indices, benchmarks, GHL

- **Indices** computed server-side: TP3 trust/proactivity/productivity indices, participation rate, average satisfaction/NPS, key scale items (clarity of priorities, ownership), pre-vs-post deltas.
- **Exports:** participant-level CSV (deep analysis / future AI training) + sponsor-summary CSV (workshop aggregates, indices, NPS).
- **GHL mapping** — summary KPIs only (portal stays source of truth): Last Workshop NPS, Trust/Proactivity Index, Workshop Date, Industry, Audience Level, Diagnostic Fit (yes/no/maybe). Manual CSV import now; webhook/direct sync designed-for, deferred.

---

## 7. Feedback / testimonial / bonus / referral (NPS branching, in `workshop-survey.js` + `workshop-room.html`)

Sponsor satisfaction survey after debrief. Base 3 questions, then branch on NPS:
- **9–10 (promoter):** enhanced testimonial questions → consent toggle → "Bonus unlocked" (configurable locked asset) → strong referral flow (reuses `referrals`, pre-drafted intro email, pushes to GHL with tags).
- **7–8 (satisfied):** emphasize the "one improvement" question (stored as product feedback) + optional 1-line testimonial; soft, low-emphasis referral; no bonus by default.
- **6 (borderline):** service-recovery questions only; tag workshop "needs review"; surface in coach console.
- **0–5 (red flag):** service-recovery only; no upsell/bonus/referral; auto-flag for Alex, surface prominently.

Approved testimonials (with consent) can surface on the sponsor dashboard and export for marketing.

---

## 8. Post-debrief recap email
From the sponsor dashboard, "Send recap" emails the sponsor: key metrics (participation, NPS, TP3 snapshot), top strengths/risks, agreed 90-day focus, link back to the dashboard, and an optional "Discuss the 14-Day Executive Diagnostic" CTA when the recommendation rules are met.

---

## 9. Build layers (one branch, validated each step, tested once at the end)

1. **Foundation** — migration v35; coach Workshops tab (create/tag, roster upload + account gen); sponsor `workshop-room.html` shell with exec-summary + timeline (placeholders ok); endpoint skeletons.
2. **Survey engine** — question management (standard + custom + AI-suggest/approve, pre/post sets); participant `workshop-survey.html` UX; distribution + cadence cron.
3. **Data layer** — indices/deltas, benchmarks, participant + sponsor CSV exports, GHL field mapping.
4. **Flywheel** — NPS branching, testimonial + consent, bonus unlock, referral loop, recap email.

---

## 10. Testing (single comprehensive pass on the Vercel preview)

Seed clearly-labeled `TEST ` workshops covering: strong / mixed / weak result profiles; standard + private; full roster + a 1-person edge; pre-only, pre+post; every NPS branch (10 / 8 / 6 / 3). Exercise the full lifecycle, all exports, the recap email, and each feedback branch. Then a **regression pass** on existing flows: coach login, a client portal check-in, Ask Alex, a Decision Room sponsor link, a diagnostic survey. Provide a one-line cleanup script deleting only `name like 'TEST %'` rows in FK-safe order. `check.sh` green (escaped-backtick baseline 0) before every commit.

---

## 11. Open items I'll decide unless you object
- **Sponsor access:** token-gated `workshop-room.html` link (matches Decision Room) rather than a login, for v1.
- **Reconciling with the existing `sponsors` table:** workshop sponsor identity lives on `clients` (one profile); I'll link to a `sponsors` access row only if needed for the dashboard token, to stay consistent with the DR without duplicating the person.
- **AI models:** Sonnet for exec summary/report-grade text, Haiku for cheap question suggestions (matches current usage).
- **Bonus asset:** stored per workshop in `bonus_resource_config` (Drive link or portal resource), set in the coach tab.
