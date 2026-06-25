# GPS Portal — Master Build List (prioritized, de-duplicated)

**Compiled:** June 24, 2026
**Sources reconciled:** `GPS-PORTAL-ROADMAP.md` (dated May 2026), `GPS_PORTAL_BACKLOG.md` (dated June 5, 2026), and the `cio_findings` ledger in Supabase (open items as of today). Duplicates across sources have been merged; items that have shipped since those lists were written are moved to Section 4 so they can be crossed off.

Priority key: **P1** = do soon / time-sensitive · **P2** = high value, schedule it · **P3** = later / nice-to-have. Effort is a rough t-shirt size.

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
