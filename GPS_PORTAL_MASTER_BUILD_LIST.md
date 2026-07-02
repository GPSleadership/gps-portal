# GPS Portal — Master Build List (prioritized, de-duplicated)

**Compiled:** June 24, 2026 · **Last updated:** July 1, 2026 (full six-lens audit merged — see new top section)
**Sources reconciled:** `GPS-PORTAL-ROADMAP.md` (dated May 2026), `GPS_PORTAL_BACKLOG.md` (dated June 5, 2026), the `cio_findings` ledger in Supabase, and the **July 1, 2026 full audit** (`EIS_Master_Audit_and_Plan_2026-07-01.md` + appendices: app, security, ux-mobile, frontier, opportunities, premortem). Duplicates across sources have been merged; items shipped since these lists were written are in Section 4.

Priority key: **P0** = live exposure / live revenue loss, fix now · **P1** = do soon / time-sensitive · **P2** = high value, schedule it · **P3** = later / nice-to-have. Effort is a rough t-shirt size.

---

## 🚨 TOP PRIORITY — July 1, 2026 Full Audit (do first, in this order)

Full detail and evidence in **`EIS_Master_Audit_and_Plan_2026-07-01.md`**. Every P0 was independently verified against the live site, the repo, or the database. **Ship all through `gps-portal-safe-build` — never push straight to `main`.**

### P0 — Fix now (live exposure or live revenue loss)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P0-1** | **Personal financial data public** — `gps-executive-console.html` served with bank balances, card last-4s/APRs, payroll, client deals in static HTML; login is a JS overlay only. Add to `.vercelignore` + redeploy today; then re-home behind `/api/console-data` auth. Rotate anything referenced. | S | 🔧 building | Verified: file tracked, only `-deploy` variant ignored |
| **P0-2** | **Renewal/upsell offer silently dead** — `portal-data.js:436/445` queries phantom `clients.is_coaching_client` → 400 → `show:false` for every client. Sergio's $10K credit window is open **through July 7** and showing nothing. Fix: use canonical `in_coaching_program \|\| coaching_sessions_enabled \|\| is_active_coaching`; add `renewal-options` to synthetic-check. | S | 🔧 building | Verified: 400 in live logs; Sergio `debrief_complete` 6/30, credit URL configured |
| **P0-3** | **Seven public zip blobs** (`zi5BMnX1`…`ziw7HK1Q`) leak full portal + api source, DB schema snapshot, Ask-Alex system prompt. `git rm` all seven + redeploy; rotate captured secrets. | S | 🔧 building | Verified: 7 blobs tracked & served |
| **P0-4** | **Unauthenticated privileged actions** in `api/diagnostic.js` (`send-invites` L661, `generate-question` L1049, `generate-g2-question` L1145, `finalize-report` L2024, `import-survey-data` L3620) — service-key writes/email/Anthropic spend with only a method check; IDs interpolated without `encodeURIComponent`. Add `verifyCoachSession` + encode all IDs. | M | ⏳ queued | Verified: code read |

### P0.5 — Structural prevention (stops the next P0)

- **Deploy is a denylist → every new file is public by default.** How BOTH P0-1 and P0-3 escaped. Move to an allowlist deploy (explicit `public/` set) **or** add a pre-push check that flags any newly tracked non-HTML/JS file. Highest-leverage prevention in the audit. — M

### P1 — This week

- **Coach dashboard crash still live** — `Cannot read properties of null (reading 'remove')`, 8 hits July 1; guard the inline `getElementById(...).remove()` handlers in `coach.html` (4330, 4779, 9051, …). — S — *Verified (client_errors)*
- **Re-skin the three assessment pages** (`feedback.html`, `survey.html`, `diagnostic-survey.html`) to the real GPS palette (`#004369` / teal `#01949A` / red `#DB1F48`), add the logo, strip all emoji. First thing a stakeholder sees; currently looks like a cheaper, different company. Cheapest trust win in the system. — S–M
- **Fix wizard step-count contradiction** — top bar "STEP 1 OF 8" vs inner "Step N of 7" (`client.html` step badges + `wizSteps` render). — S
- **Restore mobile wizard step context** — at ≤480px all step labels hide (`client.html:417`); keep one persistent "Step N of 7 · <label>" line. — S
- **`business_outcome_goal` leaks to client browser** (UI-only gate) — return an explicit column allowlist from `get-client.js:463`. — S

### P1/P2 — Reliability batch (next 30 days) — extends the June 24 Reliability path

- **Email failure handling** — failed Resend drafts stay `scheduled`, retry every 15 min forever, no cap/alert. Stamp `last_error`/`attempts`, alert after N, pin FROM domain. — M
- **Cron heartbeats for the 3 silent jobs** — `diag-send-scheduled`, `survey-send-scheduled`, `workshop-reminders` (send-scheduled delivers sponsor sequences + invites). — S
- **Add `renewal-options` (+ one write-free action per feature) to `synthetic-check`** — the money path had no monitor. — S
- **P2 severity routing** — detector files everything P2 but the daily brief only surfaces P0/P1, so real issues never reach Alex. — S

### Conversion (Decision Room) — next 30 days

- **Sample-diagnostic proof at the sticky CTA** (`decision-room.html:170`) — currently a hard conversion fail; highest-converting lever. Add "See a sample readout →" thumbnail. — S
- **Strengthen CTA copy** ("pick a start date; we'll send your prep brief"); protect the sticky label at 390px. — S

### Engagement loop — this quarter (highest-ROI *feature* work; feature-rich but engagement-poor: 32 clients, 12 check-ins ever)

- **One-tap email check-in** — "On track / Partial / Off track" buttons inside the Monday reminder via a tokenized endpoint. Likely the single biggest completion lever. — M — *NEW*
- **Personalized AI nudge in the reminder** — 2 lines in Alex's voice referencing the client's own behavior + last check-in, generated in `send-reminders.js`. — M — *NEW*
- **Resurface last week's commitment** — show `planned_action` atop Form A with Done/Not-done (currently write-only). — S — *NEW*
- **Recurring stakeholder pulse** — 2-question mini-survey to 3–5 stakeholders; trend-lined; reuses feedback plumbing; arms renewals. — M — *NEW*
  - **Cadence (decided 2026-07-02, w/ council):** Sprint 1 (first 90 days) = **3 pulses**, sent internally at **day 21 / 45 / 80** (outward-facing "30 / 45 / 90" — sent ~1 week early to absorb response lag so reads are in by the 30/90 marks). Reject **weekly** — that was Steven's setup and it burned out his stakeholders (his original doc told him to ask weekly).
  - **Show progress, not just a data dump:** each pulse (and especially the final one) shows the stakeholder how far the leader has moved — a "here's the change" peak-end, not another cold ask. (Sutherland/Goldsmith.)
  - **Auto-taper:** when a behavior scores **4+/5 across raters on 2 consecutive pulses**, system suggests easing off / pauses further pulses (measurement retires once the behavior is embedded).
  - **Post-90 / renewal:** coach picks cadence tier per new goal — **Aggressive** (sprint cadence) / **Light** (45 + 90 only) / **Off** (leader-only). Default Light unless a genuinely new behavior warrants restarting the aggressive window.
  - **Leave the leader's own weekly check-in unchanged** — weekly is fine for self-discipline; it's stakeholder-facing frequency that must taper.
  - Schema note: `survey_schedules`, `scheduled_survey_sends`, and `coaching_cadence` already exist — build adds the coach-facing cadence-tier picker + the taper logic.
- **Tool of the Week** in the reminder email (35 tools, 3 opens ever). — S — *NEW*
- **Post-check-in renewal/referral moment** — ask after a delivered win, never during setup. — S — *NEW*

### Security hardening (extends the June 24 Security path)

- **Revoke blanket anon/authenticated DML** on the 43 public tables (table-by-table + smoke test) so RLS deny-all isn't the *only* backstop. — M
- Rotate + hash `control_password`; drop dead anon `createClient` blocks from HTML; export & drop the two `backup_*` PII schemas; stop serving stray root `.js`; tighten `/api/*` CORS to portal origin; retire plaintext-password fallbacks. — S each

### Mobile polish (client core already mobile-hardened + PWA shipped)

- Set wizard button heights on their own class; bump coach buttons 42→44px; **pilot web push** (the one capability the PWA lacks). — S / Test-tier

### Growth (business, not portal) — frontier scan

- **Succession-Readiness reframe of the 14-Day Diagnostic** (zero new build; pitch to member programs like HDA Truck Pride). — S
- **Owner-Dependence Index** — free benchmarked 10-Q wedge on the existing survey engine; feeds the diagnostic pipeline. — M
- **"Lead Through the Wait" positioning** — rewrite diagnostic marketing in the distributors' uncertainty language. — S

### Brand presence audit & consolidation (business, not portal) — *ADDED 2026-07-02, not started*

**End goal:** a trucking / parts / logistics CEO who Googles "Alex Tremble" lands on a cohesive brand that immediately speaks to *their* world — not a government-leadership legacy. Four workstreams:

1. **alextremble.com redirect + flush.** Verify `alextremble.com` is redirecting to `gpsleadership.org`. If yes, delete all remaining content from `alextremble.com` and request a cache/index refresh in Google Search Console to flush the old pages faster.
2. **gpsleadership.org About + testimonials refresh.** Rewrite the About page and testimonials to *lead* with trucking, parts & service, and logistics client stories instead of government examples. Pull real client wins from the current ops-heavy book of business (anonymize per brand rules unless cleared).
3. **Podcast SEO & positioning — *The Executive Appeal*.** Audit the show's SEO/positioning across major directories; make sure the description explicitly names the ICP (ops-heavy, multi-location CEOs) on Spotify, Apple Podcasts, and the RSS feed so ops CEOs find it when searching for leadership content in their space.
4. **LinkedIn consistency.** Light refresh of the profile headline + Featured section to mirror gpsleadership.org messaging, so all surfaces are consistent.

### Doc hygiene

- `GPS-PORTAL-ROADMAP.md` still lists **PWA as "planned"** — it's shipped. Prune roadmap/backlog so this list stays the single source of truth.

---

## ⭐ TOP PRIORITY — Hardening to an A (June 24 deep dive)

Full detail and evidence in **`GPS_PORTAL_DEEP_DIVE_2026-06-24.md`**. All net-new items are tracked in `cio_findings` (source `deep-dive-2026-06-24`). Current grade: **C** (Security C+, Reliability C‑). Goal: A on both.

### Reliability path (C‑ → A) — *IN PROGRESS*
Root problem: failures happen silently. Fix = fail loud, stay tested, be recoverable.

- **R1 — Stop the silent bleeding (→ B‑):** fix dead 5-day continuation email sequence (bad `is_coaching_client` column); fix broken profile-save in `client.html` (route anon update through `portal-data` endpoint); escalate email-delivery failures in `detect_breakages` to P1 so the brief surfaces them; add Resend key + from-domain checks to `health.js`; `email_log.sent_at DEFAULT now()`.
- **R2 — Catch what the detector can't see (→ B+):** **cron heartbeats** — every scheduled job records `last_success_at`; `detect_breakages` flags any overdue cron (would have caught BOTH silent failures found today); route all email senders through one always-logging helper; make `CRON_SECRET` required.
- **R3 — Integrity + recoverability (→ A‑):** resolve `clients` column drift (`org` vs `organization` 21/21 mismatched); off-platform/PITR backups + one real test-restore; smoke-test `report_doc` on a real client.
- **R4 — Prove it continuously (→ A):** daily golden-path synthetic test (TEST account logs in, loads plan, submits check-in, hits diag-get + Ask Alex on prod, alerts on any break); weekly reliability line in the brief.

### Security path (C+ → A) — *NEXT*
- **S1 — Fix now:** `business_outcome_goal` server-side gate in `get-client.js` (shipped-today leak); drop anon INSERT/UPDATE on `storage.objects` (diagnostic-reports); de-deploy `ops-console-deploy` (client-side-auth + anon financial access); rotate all Vercel secrets (April breach).
- **S2 — 30–60d:** hash `control_password` + `ea_console_settings.password` (rotate the known EA pw); move financial `accounts` out of `gps_settings`; `ALTER FUNCTION detect_breakages() SET search_path`.
- **S3 — Before 90d:** export + drop `backup_*` PII schemas (RLS off); apply Node June-2026 CVE patch when re-landed; graceful coach session-expiry; remove/auth-gate deployed sandbox pages.
- **Watch:** monthly anon-policy + RLS-off scan; per-coach identity + audit log when a second user is added.

---

## Section 1 — Security & reliability (from the findings ledger)

These are fixes, not features. A few are time-sensitive. Several are flagged "Alex approval required" because they touch credentials or live policies.

| # | Item | Sev | Effort | Notes |
|---|------|-----|--------|-------|
| 1 | **Vercel April 2026 breach — rotate env vars** | P1 | S | Check for a Vercel breach notice; treat non-sensitive env vars as possibly exposed; rotate keys (Resend, Supabase service, Anthropic). Mostly an Alex/ops action. |
| 2 | **Node.js June 2026 HIGH CVEs (Vercel reverted patch)** | P1 | S | Audit `api/*.js` for outbound HTTPS relying on TLS hostname verification; monitor Vercel changelog for the re-rollout. |
| 3 | **Anon role can UPDATE storage.objects in `diagnostic-reports`** | P2 | S | Any unauthenticated request can overwrite report PDFs. Drop the `gps_diag_reports_update` anon policy (or scope it). |
| 4 | **Plaintext admin password in `gps_settings` (`control_password`)** | P2 | S | `pw_hash` is the real auth; delete the plaintext `control_password` key after confirming nothing reads it. |
| 5 | **Backup schemas have RLS disabled** | P2 | S | `backup_testdata_20260605` + `backup_vanessa_20260605` protected only by a missing grant. Drop them after confirming no code references them. |
| 6 | **coach.html session-expiry errors (unhandledrejection bursts)** | P2 | S | `coachData()` throws on expired session instead of redirecting to login; 20+ errors logged June 17–21. Catch "invalid/expired" → redirect to login. |
| 7 | **Daily brief reads state tables via anon key (silent fallback)** | P2 | M | `gps-daily-brief` etc. hit `finance_state`/`client_state`/`ops_state` with the anon key (no grant) so they silently fail. Route through the service-role path. |
| 8 | **Google sign-in alert on tremblegps@gmail.com** | P2 | — | Confirm the sign-in was you; if not, rotate. Not a build. |
| 9 | **Supabase Auth OIDC bypass CVE (Apple/Azure)** | P3 | — | No affected users today. Just confirm Auth is on ≥ v2.185.0; re-evaluate only if Apple/Azure login is ever enabled. |

---

## Section 2 — Features & enhancements (de-duplicated)

### Build next (high value, mostly small)
| Item | Source(s) | Effort | Notes |
|------|-----------|--------|-------|
| **Coaching-cadence selector** (weekly/biweekly/monthly per client) | Backlog | S | Drives the attendance denominator; today it's only set in the DB. Coach-side dropdown. |
| **Metric trend chart** on client detail (baseline → weekly → target) | Roadmap P2 | M | Makes progress visible without reading every check-in. |
| **Missed check-in flag** in coach dashboard (no submission 10+ days) | Roadmap P2 | S | Visual badge on the client row. (`last_checkin_reminder_at` exists — verify what's already wired.) |
| **Inline coach edit of Decision Room cards** (focus / succession) | Backlog | S–M | Generation fills them; quick inline edit is the fast-follow. |
| **Client "anything for our next call?" capture** on the check-in | Roadmap P2 | S | Free-text on Form A, surfaced in the coach check-in detail. |
| **report_doc → branded PDF** | (this session) | M | Wire report_doc as the source for the client PDF via the diagnostic-report-formatter, so one document feeds snapshot, plan, and PDF. |
| **AI-suggest the business outcome** (sponsor's success bar) | (this session) | S | Draft `business_outcome_goal` from the discovery/intake notes or supervisor feedback (e.g. Peter's "3–5% growth"); coach confirms with the sponsor and accepts/edits. Stays manual until built. |

### Build later
| Item | Source(s) | Effort | Notes |
|------|-----------|--------|-------|
| **In-portal question review & approval** (kills email back-and-forth) | Backlog | M–L | Phase 1 = read-only shareable preview link (low effort, removes most friction). Phase 2 = approve / request-change / edit + status flow + notifications. |
| **SMS check-in nudge (Twilio)** | Roadmap P2 #6 **+** Backlog (merged) | M | Needs Twilio account, number, A2P 10DLC registration, opt-in consent. Wire alongside the email on the same "Send reminder" button. |
| **Legacy 360 CSV importer** | Backlog | L | Ingest past diagnostics from CSV (text-match columns, "Self" row = leader, map 1–5 + 1–10 impact, capture START/STOP/CONTINUE). Label as a prior instrument. |
| **PWA (add-to-home-screen)** | Roadmap P2 #1 | S | Installable mobile experience; same backend. ~half-day config. |
| **Timezone-precise reminders** | Roadmap P2 #5 | S–M | Today all fire 9am ET (PT clients get 6am). Stagger by stored timezone. |
| **Named coach/admin logins + audit log** | Backlog **+** Roadmap P3 "multi-coach" (merged) | M | `admin_accounts` table is the foundation. Trigger-based: first second human in the console, or first gov/enterprise security review. Keep clients frictionless (token links); add logins only on the coach/admin side. |
| **Coach dashboard polish:** filter by TP3 pillar, bulk archive, progress bar (week X of 12) | Roadmap P2 | S each | Small quality-of-life items. |
| **GoHighLevel auto-sync** on plan submission | Roadmap P2 | M | Beyond today's CSV export; needs GHL API key + custom field IDs. |

### Under consideration (Phase 3)
Renewal outreach after week 12 · client self-service onboarding · milestone celebrations (wk 4/8/done) · client-facing 90-day journey summary at week 12 · true native app · project-agnostic "safe build" skill (only if a second external portal appears).

---

## Section 3 — Already shipped since these lists were written (cross off)

The roadmap/backlog predate a lot of work. These appear done — verify and remove from the source files:

- **Engagement roles: Sponsor vs POC** — migration v47 is applied (confidentiality gating). *Backlog still lists it as open — likely done or partly done; verify.*
- **Decision Room** — team-tied reports, branded-PDF model, AI recommendations (edit/reject/approve), content generation, succession/bench.
- **Workshop & Assessment module** (v35–v39) — coach console, participant + room/QR survey, sponsor dashboard, NPS flywheel, exports.
- **Structured report (`report_doc`)** + client snapshot + coach-approved 90-day plan prefill + `business_outcome_goal` on the sponsor page (this week).
- **Generate-full-report**, fill-empty toggle, business outcome on the leader plan (the branch in flight now).
- **Anonymous diagnostic feedback** (hard-cut anonymity, v55/56).
- **Email check-in nudge**, **GHL CSV export**, **Day 1/30/90 checkpoints**, **ad-hoc external feedback link**, **multi-select client filters**.
- **Coach-only notes per client** — `coaching_notes`/`coach_summary` exist; the roadmap "Notes field per client" may be satisfied — verify.
- **Per-coach identity + RBAC enforcement (was "Watch" under Security path)** — *June 25, 2026, branch `coach-identity-attribution`.* Closed the gap where the login stamped no identity, so every coach session (including the EA, Anna) was silently treated as owner. Login now stamps `lvl`/name/email/account-id (shared password = owner/Alex; admin_accounts password = that account's role). The existing owner-only delete/template guards in `coach-data.js` are now actually enforced, so the assistant cannot delete clients/diagnostics/teams/workshops or edit global templates. Messaging was opened to assistants, and messages are attributed to the real sender end to end (DB `coach_messages.sender_name`/`sender_admin_id` via migration v72; email from/subject/reply-to; client + coach thread display). **Still open from the Watch item: an audit log of coach-side actions.**

---

## Section 4 — Ops / non-code (Alex actions)

- **Upgrade Supabase free → Pro (~$25/mo)** — for automatic DB backups / point-in-time recovery and to stay under storage/bandwidth ceilings as report PDFs accumulate. Worth doing before a major engagement.
- **Migration label cleanup** — three different migrations are tagged "v66" (`v66_diagnostic_kickoff_fields`, `v66_survey_schedules`, `v66_structured_report_doc_and_business_outcome`). Renumber the next one to avoid ambiguity.
- **Env var rotation** — see Section 1, items 1–2.

---

*Note: the roadmap and backlog source files are stale. Once you've confirmed Section 3, I can prune those files and keep this master list as the single source of truth.*
