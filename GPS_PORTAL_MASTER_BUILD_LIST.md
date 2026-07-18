# GPS Portal — Master Build List (prioritized, de-duplicated)

**Compiled:** June 24, 2026 · **Last updated:** July 3, 2026
**Sources reconciled:** `GPS-PORTAL-ROADMAP.md` (dated May 2026), `GPS_PORTAL_BACKLOG.md` (dated June 5, 2026), the `cio_findings` ledger in Supabase, and the **July 1, 2026 full audit** (`EIS_Master_Audit_and_Plan_2026-07-01.md` + appendices). Duplicates across sources have been merged.

---

## 📌 GOVERNANCE — Single Source of Truth

**This file is the one backlog.** All other lists (Supabase `council.portal_roadmap`, `GPS-PORTAL-ROADMAP.md`, `GPS_PORTAL_BACKLOG.md`, session task lists) are deprecated. Do not add portal build items anywhere else.

**Rules:**
1. New build idea → add it here before starting work (pick the right priority section).
2. End of every session → update status of items worked on (mark ✅ Done with date).
3. `cio_findings` in Supabase stays as a **findings audit ledger** (evidence trail), not an action backlog. The prioritized action list lives here.
4. `council.portal_roadmap` (4 items) → archived; superseded by this doc.
5. This file should live in the `gps-portal` repo at `docs/MASTER_BUILD_LIST.md` so it's version-controlled alongside the code. **Next commit: move it there.**

---

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

### P0 — Rater confidentiality (added 2026-07-13, JMAA/Rosa audit)

Standard of record: **`Knowledge/GPS-Frameworks/Rater Confidentiality Standard.md`** (Obsidian vault). Any change to reporting, prompts, PDFs, or exports must conform to it.

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P0-C1** | **No MIN-N suppression anywhere in the diagnostic path.** `buildRaterGroupData` returned scores + verbatims for every group with no n check. Rosa Beckett's Peers group = **n=1 (Kimberly Carlisle) with 13 verbatims** incl. "Threatening the team. Micromanaging." Would have rendered under a "Peers" heading. Fix: MIN-N=3 hard floor + complementary (residual) suppression + verbatim scrub from the All Others pool. | M | ✅ Done 2026-07-13 (`feature/diagnostic-min-n`) | `api/diagnostic.js:1633-1655` (old); verified against live JMAA data |
| **P0-C2** | **`scores_json.by_group` propagates sub-3 groups to the LEADER, COACH and SPONSOR.** Read by `results-visual.js`, `coach.html`, `decision-room.html`, `sponsor-data.js`. Filter suppressed groups at the write. | S | ✅ Done 2026-07-13 | Live drafts: Sergio `direct_report n=1`, Michael Gater `peer n=1` |
| **P0-C3** | **Board Members not a real group** — fell through `normalizeRel()` to null and blended into Other Colleagues. Protected by accident. Promote to a first-class confidential, aggregate-only, MIN-N group. | S | ✅ Done 2026-07-13 | `api/diagnostic.js:1549-1562` (old) |
| **P0-C4** | **Survey copy promised aggregation we did not enforce** ("Scores are averaged across raters") and promised anonymity to the *supervisor*, whom we attribute. Three-way consent copy: self / supervisor / everyone else. | S | ✅ Done 2026-07-13 | `diagnostic-survey.html:351,374,747` (old) |
| **P0-C5** | **Coach confidentiality gate** — report generation blocked (409) until the coach reviews what is withheld. Acknowledging does not unsuppress. | S | ✅ Done 2026-07-13 | new |
| **P1-C6** | **Historical drafts still carry sub-3 groups.** Sergio Sabido's *delivered* report had `direct_report n=1`; Michael Gater's coach preview has `peer n=1`. Their `scores_json.by_group` blobs are still read by the leader + sponsor views. Decide: scrub the stored blobs, or regenerate. | S | ⏳ **queued — Alex's call** | DB query 2026-07-13 |
| **P1-C7** | **Raters name other people inside verbatims.** A live JMAA peer verbatim names another leader by first name. MIN-N does not catch this. Needs a de-identification pass over verbatim text before display. | M | ⏳ queued | Live JMAA data |
| **P2-C8** | **`diagnostic_raters.relationship` is free text** — no enum/constraint. Duplicates (`Manager/Supervisor` vs `Supervisor / Manager`). Single-person labels ("Other: FBO Tenant at HKS") identify by label alone. Constrain to a controlled vocabulary. | M | ⏳ queued | `information_schema` |
| **P2-C9** | **`anonymous_feedback = false` path retains `rater_id`** while the copy promises non-attribution. Either enforce or change the copy. | S | ⏳ queued | `api/diagnostic.js` |
| **P2-C10** | **Update the report-generation prompt** to carry Section 7 of the Confidentiality Standard (the six "never do" rules). Alex holds the prompt. | S | ⏳ **queued — Alex holds the prompt** | — |

### P0 — Survey window (added 2026-07-13, found live during the JMAA close)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P0-S1** | **Every survey closed 4 hours early.** Auto-close compared `close_date` to the **UTC** date (`api/diagnostic.js:891`); midnight UTC is 8:00 PM ET. Every rater silently lost the last 4 hours of the day they were promised. Hit the whole JMAA exec cohort at once — Rosa, Jana, Kimberly, Michael all flipped shut at `00:00:19 UTC`, and a chief (Patrick Minor) was locked out mid-evening. Now compares against the `America/New_York` date, so surveys close at **11:59 PM ET** on `close_date`. | S | ✅ Done 2026-07-13 (`feature/survey-extend`) | DB: 4 diagnostics `survey_closed_at = 2026-07-14 00:00:19Z` |
| **P0-S2** | **No way to extend or reopen a survey without a database edit.** Added `extend-survey` (coach-gated) + a "Change close date / Reopen survey" button on the rater card. Blocks reopening a **finalized** report (would change numbers under a document the leader already read); warns when a draft exists. | S | ✅ Done 2026-07-13 | new |
| **P1-S3** | **Extending a survey notifies nobody.** The new button silently buys raters time they never learn about. Worse on cohorts like JMAA where `suppress_auto_reminders = true` (they use the consolidated nudge, which is *scheduled*, not automatic) — so an extended survey can close a second time with the outstanding raters never having heard a word. Caught only because Alex asked. Fix: on extend/reopen, offer to (a) send the per-leader reminder, or (b) schedule/queue a consolidated nudge for the cohort. Should be one checkbox in the extend modal. | S | ⏳ queued | Live: JMAA had `scheduled_nudges` last fired 2026-07-10; nothing queued for the 7/14 close until manually inserted |
| **P2-S4** | **Reminder state is not reset on extend.** `reminder_1_sent_at` / `reminder_2_sent_at` are one-shot guards. A survey extended past its original close will never re-send R1/R2 to anyone who already got them. Decide: clear the stamps on extend, or add a third "extended" reminder. | S | ⏳ queued | `api/diagnostic.js:3698,3717` |

### P0 — Goal celebration fired weeks early (added 2026-07-16, found live on Sergio)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P0-CEL1** | **"Congratulations on reaching your 30-day goal" showed on day 14.** `computeMilestoneState` in `portal-data.js` set `hit = metric_current >= metric_target` with **no check that the target date had arrived**, so any leader whose proxy metric already exceeded target got a false 30-/90-day celebration immediately. Live hits: **Sergio Sabido** (day 14, metric 20/10 — 30- and 90-day both fired), **David Winjum** (day 27, metric 2/2 — 30-day showing, 90-day already misfired & dismissed 7/10). Fix: gate the hit on `day_n >= days` (`reached`) so a milestone can't celebrate before its checkpoint. `metricMet` stays descriptive; `hit`/`missed`/`should_celebrate` now require the window. | S | ✅ Done 2026-07-16 (commit 5bf2be7, deployed via `vercel --prod` during the GitHub outage) | `portal-data.js:183` (old `hit`); DB confirmed start dates vs day_n |
| **P0-CEL1a** | **Immediate mitigation + reset (done):** stamped `celebrated_30_at = now()` on Sergio + David to take the live false message down under the old code; after the fix went live, reset both `celebrated_30_at`+`celebrated_90_at` → null so genuine checkpoints celebrate (David's real day-30 is 2026-07-19). Verified null 2026-07-16. | S | ✅ Done 2026-07-16 | SQL run 2026-07-16 |
| **P1-CEL2** | **Deploy path: GitHub outage broke auto-deploy 2026-07-16.** GitHub's webhook to Vercel stopped firing (Vercel showed a "GitHub Outage" banner) so pushes to `main` did not build. Worked around with `npx vercel --prod` (deploys the local tree directly, bypasses GitHub). Until GitHub recovers, deploy with `vercel --prod`, not by pushing. When the outage clears, confirm Settings → Git reconnected so auto-deploy resumes. | — | ⏳ watch — use CLI until GitHub recovers | Vercel banner + `list_deployments` showed no build for 5bf2be7/3aefc85 |

### P3 — DB hygiene from the 2026-07-17 system audit (defer; all INFO/WARN, pre-existing)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P3-DB1** | Function `public.capture_bad_outbox_item` has a mutable `search_path` (advisor WARN `function_search_path_mutable`). Set `search_path` explicitly. Low risk, pre-existing. | S | ⏳ later | security advisor 2026-07-17 |
| **P3-DB2** | Unindexed foreign keys (`survey_responses.token_id`, `sponsors.linked_client_id`, `email_drafts.diagnostic_id`, a few workshop tables) + several unused indexes. All INFO; immaterial at current row counts. Revisit if a query slows. | S | ⏳ later | performance advisor 2026-07-17 |

### P1 — Multi-file message attachments (added 2026-07-17, Alex — "relatively soon")

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-MSG1** | **Multiple attachments per message (up to 5).** ✅ Done 2026-07-17. v104 `message_attachments` child table (FK cascade); `coach-data.js` + `portal-data.js` gained `uploadMsgAttachments`/`fetchMsgAttachments`/`insertMsgAttachments` and a rewritten `withSignedAttachments` that returns `msg.attachments[]` (child rows, else legacy single); reply/start/coach-message-send accept `attachments[]` (cap 5, 10 MB each). Composers on `coach.html` (reply) + `client.html` (leader) now `multiple`, show a "N files: …" chip, read all files, and render one card per attachment. Backward-compatible: old single-attachment messages still render. node --check + JS sweep clean. **Post-deploy smoke:** send 2–3 files each way, confirm all download. | M | ✅ Done 2026-07-17 (awaiting deploy) | coach-data.js, portal-data.js, coach.html, client.html, v104 |

### P1 — AI kill-switch: admin toggles for every AI feature (added 2026-07-16, Alex — "do soon")

**Why:** Alex does not want the practice locked into AI. If AI cost spikes, a provider degrades, or a client requires it off, he needs to disable specific AI features from the admin side and fall back to an analog/manual path — per feature, not all-or-nothing. This is a strategic hedge, not a nicety. Long-term / sub-coach resilience.

**Design:** one `ai_feature_flags` config table (singleton or per-feature rows), an `aiEnabled(feature)` helper each call site checks, and a graceful **analog fallback** per feature (manual entry, skip the step, or a templated non-AI version) — never a hard error when a feature is off. Admin toggles live in coach.html Settings, owner-only, logged. Default all ON.

**AI call sites to wrap (verified 2026-07-16 — 8 endpoints):**

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-AI1** | Audit + confirm the exact user-facing feature behind each AI endpoint and design its analog fallback: `ask.js` (Ask Alex Q&A), `diagnostic.js` (report generation + question/G2 generation), `diag-portal.js` (leader diagnostic view), `portal-data.js` (vision specificity gate), `coach-data.js`, `workshop-data.js`, `testimonial.js`, `health.js` (provider ping — infra, not a user feature). | M | ✅ Done 2026-07-17 (mapping settled in P1-AI2) | grep of `api/` for provider/model calls, 2026-07-16 |
| **P1-AI2** | ✅ **Done 2026-07-17 — all 8 AI features wired to the kill-switch.** Shared `aiFeatureEnabled(feature)` helper added per file (fail-open: missing/unreadable row = ON; only explicit `enabled=false` = OFF). Gates + analog fallbacks: `ask_alex` (ask.js — main Q&A returns a graceful "message your coach" reply; wizard prefill returns `ai_disabled`), `vision_gate` (portal-data.js + diag-portal.js — accepts vision as-is, no AI check), `testimonial_ai` (testimonial.js — generic benefit line), `workshop_ai` (workshop-data.js — clear "add manually" message on the 5 helper actions), `question_generation` (diagnostic.js generate-question + G2), `report_generation` (diagnostic.js generate-report + report-section + plan-prefill + team-report → graceful `ai_disabled` 200), `diagnostic_summary` (diagnostic.js generate-dr-content + generate-recommendations). All 8 added to `AI_ENFORCED` in coach.html so every dashboard row reads "Live". `node --check` + JS sweep clean. **Note:** the two diagnostic email-drafters (`draft-kickoff-email`, `generate-email-drafts`) are AI but have **no flag** — left ungated (email automation, not in the 8-flag set). Add a `diagnostic_email_ai` flag later if Alex wants those on the dashboard too. | M | ✅ Done 2026-07-17 (awaiting deploy) | ask.js, portal-data.js, diag-portal.js, testimonial.js, workshop-data.js, diagnostic.js, coach.html |
| **P2-AI5** | **Add the two diagnostic email-drafters to the AI kill-switch** (added 2026-07-18, Alex). `diagnostic.js` `draft-kickoff-email` (handleDraftKickoffEmail, callClaude @ ~354) and `generate-email-drafts` (handleGenerateEmailDrafts, callClaude @ ~4759) are AI but currently **ungated** — they're outside the 8-flag set. Add a new `diagnostic_email_ai` flag (seed row), gate both handlers with `aiFeatureEnabled('diagnostic_email_ai')` → analog fallback (coach writes the email manually), and add it to `AI_ENFORCED` in coach.html so it appears on the AI Controls dashboard. | S | ⏳ queued — later | diagnostic.js handlers; 8-flag retrofit was P1-AI2 |
| **P1-AI3** | **Central AI Controls dashboard** ✅ Done 2026-07-17 — coach.html Settings → **AI Controls** subtab, owner-only, lists all 8 AI features with on/off toggles (via `ai-flags-list`/`ai-flag-set`), each row shows Live vs "enforcement rolling out". This is Alex's "one place to govern every AI function." All 8 flags seeded. | M | ✅ Done 2026-07-17 (awaiting deploy) | coach.html |
| **P1-M6** | **Perception Scoreboard: add Day 60 column** (coach.html) — header + per-stakeholder rows + peer-average row now show Baseline / Day 30 / Day 60 / Day 90; change uses latest of 90→60→30. Matches the 30/60/90 cadence. JS sweep clean. | S | ✅ Done 2026-07-17 | coach.html scoreboard |

### P1 — Measurement architecture rebuild (started 2026-07-16, Council-reviewed)

Decision + Council rationale in the vault decision note. Architecture: **30-day = self-report (sustained behavior average); 60-day = blended, directional; 90-day = decisive on stakeholder trust vs a target set at plan-time.** Cadence moves 30/45/90 → **30/60/90**. Feedforward rater question added at baseline + 60 + 90. Ship via `gps-portal-safe-build`; deploy with `vercel --prod` while the GitHub outage persists.

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-M1** | **Sustained + capped-consistency achievement rule.** `computeMilestoneState` judges "reached" on the recent check-in window (30-day = last 3, 90-day = last 4, >= 2 obs), never a single `metric_current` snapshot, gated on the checkpoint date (P0-CEL1). **Capping (added 2026-07-16, Alex's catch):** each week's credit = `clamp((v-baseline)/(target-baseline),0,1)` — a week ≥ target = 100%, no more — averaged, must clear `CONSISTENCY_THRESHOLD` (0.9). A spike week can't offset light/zero weeks. Verified: Sergio 0/5/20 → 50% no-hit; 30/0/0 → 33% no-hit; 10/10/8 → 93% hit; 10/0/10 → 67% no-hit; 20/20/20 → 100% hit. `metric_consistency` added to payload. | S | ✅ Done 2026-07-16 (portal-data.js, node --check OK) | logic unit-tested; awaiting deploy |
| **P1-M1a** | Follow-up: align `send-reminders.js` milestone `hit` (line 343, single-snapshot `current>=target`) with the sustained-average rule — currently it can only wrongly *suppress a day-of nudge* on a spike (never a false celebration; celebration is in-portal only). Needs a per-client check-in fetch in the cron. | S | ⏳ queued | send-reminders.js:343 |
| **P1-M1b** | Plan-card now leads with **capped on-target consistency %** (each week ≤100%), bar + headline, latest value kept as context + a "one big week doesn't offset a light week" note. Sergio: 50% (not the misleading 83%/100%). Falls back to raw `current` when <2 metric check-ins. Matches the server rule. | S | ✅ Done 2026-07-16 (client.html, JS sweep OK) | client.html plan card |
| **P1-M3** | **90-day = decisive on STAKEHOLDER outcome (Phase 3).** v101 migration (`clients.pulse_target_90` + `_locked_at`/`_locked_by`). `portal-data.js` computeMilestoneState: the 90-day gate is always stakeholder-decided — day-90 pulse avg vs coach-set target, MIN-N of 3 raters; null target = gate not armed (no self-report fallback, no false celebration); adds `gate`/`stakeholder_*` fields. `coach-data.js` `set-pulse-target` action (approve+lock, logged who/when — the first coach approval gate). `coach.html` "90-Day Stakeholder Target" card in the stakeholder section: recommends baseline pulse avg + 0.5, Approve & lock / Update / Clear, shows lock audit line. Verified: no target→no fire; target 4.0 + 4 raters avg 4.25→reached; 2 raters→quorum fail neutral; 3 raters avg 3.67→honest not-yet. node --check + JS sweep clean. **Live-verified 2026-07-17** against production (7cfb87f) with a seeded throwaway client: target 4.0 + day-90 avg 4.25/4 raters → gate=stakeholder, hit=true, should_celebrate=true; raise target to 4.5 → hit=false, missed=true (honest not-yet), no celebration. Test data cleaned up. | M | ✅ Done + live-verified 2026-07-17 (deployed) | portal-data.js, coach-data.js, coach.html, v101 |
| **P1-M4** | **Feedforward rater question (Phase 4).** v102 migration (`survey_responses.feedforward`). `survey.html`: forward-looking question ("one thing [leader] could start doing / do more of to strengthen this") shown at baseline + day60 + day90 (hidden at day30), submitted with the response. `survey.js` submit captures it (trimmed, 1000-char cap). `coach.html`: renders it in the rater narrative as a "Feedforward · one thing to do next" card, and the coach narrative now includes **day60** (+ legacy day45). Goldsmith: future-facing, no compliance/"did they do it" question. node --check + JS sweep clean. **Leader-facing display deferred** → gated on the de-identification pass (P1-C7); coach sees it now. | M | ✅ Done 2026-07-17 (coach + capture; leader view pending P1-C7) | survey.html, survey.js, coach.html, v102 |
| **P1-M4a** | Leader-facing Feedforward ("pick one to act on") — surface to the leader once P1-C7 de-identification exists (raters name other people in free text). Until then it stays coach-only. | S | ⏳ blocked on P1-C7 | — |
| **P1-M5** | **Coaching Moment brief — Phase 5, part 1 (deterministic).** A per-leader brief at the top of the coach's stakeholder section: baseline→latest stakeholder movement (with rater n), 90-day target status (reached / not-yet / needs 3 raters / no-target), the feedforward suggestions raters gave, and a rule-based "Consider:" prompt. Facts + decision deterministic (no AI), coach-only, reuses already-loaded data. JS sweep clean. | M | ✅ Done 2026-07-17 (coach.html) | coach.html renderStakeholderSection |
| **P1-M5b** | Phase 5 part 2 — **AI-drafted talking track** on the Coaching Moment. v103 `ai_feature_flags` kill-switch; `coach-data.js` `coaching-brief-draft` (Goldsmith-grounded, Anthropic, uses ONLY the passed facts, de-id instruction, analog fallback when the flag is off) + owner `ai-flags-list`/`ai-flag-set`. `coach.html`: "Draft talking track (AI)" button + result box + owner-only kill-switch link on the card. **Ships WITH its off-switch** (Alex's principle). node --check + JS sweep clean. **Post-deploy smoke:** click Draft on a client with pulse data; toggle off → button returns the analog message. | M | ✅ Done 2026-07-17 (awaiting deploy + smoke) | coach-data.js, coach.html, v103 |
| **P1-M5c** | Phase 5 part 3 — **cross-client "Next Best Action" strip** that lights up when a checkpoint lands or a decision is pending (target-lock, publish, activate), so the coach sees what needs attention across all leaders without opening each. | M | ⏳ queued | — |
| **P2-AI4** | **Prompt-library Examples: load a gold example from an existing generated report** (AI Studio). Today the Examples field is copy/paste only. Right source for a few-shot example is the RAW generated output (pre-PDF-format) the prompt already produced — stored in `diagnostic_report_drafts`/scores, not the final styled PDF. Build a "pull example from a past client's report" picker that auto-fills input+output from the DB. (Better than copy/paste or PDF upload for this purpose; PDF upload is a separate need for source docs.) | M | ⏳ queued (Alex asked 2026-07-17) | AI Studio prompt editor |
| **P1-M2** | **Cadence 30/45/90 → 30/60/90 (additive).** `pulse-schedule.js`: `day60` offset 53, tiers now aggressive=[30,60,90]/light=[60,90], legacy `day45` kept recognized for cancel/cleanup (never renamed — checkpoint strings are non-normalized). `survey.js`: subject/body/progress-note/taper/validCheckpoints all handle `day60` (and still `day45`). `coach.html`: cadence-picker + activate copy say 30/60/90. Verified: scheduler emits day60@offset53, node --check + JS sweep clean. Coach stakeholder grid still shows baseline/30/90 (mid-pulse surfaced to coach in Phase 3). | M | ✅ Done 2026-07-16 (awaiting deploy) | pulse-schedule.js, survey.js, coach.html |

### P1 — Report generation is a 4-minute blocking call (added 2026-07-14)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-G1** | **"Failed to fetch" on report generation — false alarm on a real success.** `generate-report` is one synchronous HTTP call held open for up to 280s while Claude writes. Browsers/gateways cut the connection well before that, so the coach sees "Error generating report: Failed to fetch" **even though the server completed and wrote the draft** (confirmed live 2026-07-14: Jana Greene draft landed at 22:28:02 while the browser showed the error). Coach thinks it failed, re-clicks, wastes a generation. **Fix: make it async — POST starts the job + returns immediately; page polls `diagnostic_report_drafts` every few seconds and shows the draft when it appears. No long-held connection, no false error, coach can navigate away.** | M | ⏳ queued | Vercel logs all 200; draft row present; browser errored |

### P1 — Report flow: preview must work, then gate publish behind it (added 2026-07-14)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-P1** | **Coach preview showed no TP3 scores.** The leader page only attaches `scores_json` when the REAL status is `report_final`/`debrief_complete`/`plan_active`; `?preview=` overrides the layout client-side but the server still keyed off real status, so at `report_draft` the visual rendered empty. Fix: the preview link now carries the coach session (`&coach=<session>`); `diag-portal.js` verifies it and attaches scores for a signed-in coach preview only. Leaders have no coach session, so they still can't see scores early. | S | ✅ Done 2026-07-14 (uncommitted on branch) | `diag-portal.js:286`; Jana had `has_scores:true` but page blank |
| **P1-P2** | **Redesign the report card into a gated sequential flow** (mockup approved 2026-07-14). ORDER, per Alex's actual workflow: **1. Generate report → 2. Draft 90-day plan (pre-fills the wizard; REQUIRED before debrief) → 3. Review report + confirm the pre-filled plan → 4. Publish (HARD GATE — cannot publish until 2 and 3 done) → 5. [at debrief] Activate (grants Executive Impact System access).** One lit action at a time. Regenerate moves state backward (un-previews, re-locks publish) — closes the bug where generating a new draft silently un-finalized a finalized report (hit Jana 2026-07-14). Secondary tools (edit sections, rename groups) move to a quieter "also available" row. Confidentiality gate slots into Generate. **TWO invariants already enforced & must stay — protect them in the redesign:**
**(1) VISIBILITY: the leader sees NOTHING (no report card, no PDF, no scores) until status = `report_final` (= Publish). Before that (`report_draft`) they see only "Your report is being finalized by Alex." — even if the PDF is already uploaded and the draft generated. Gated on STATUS, not file existence (`diagnostic-leader.html:768`). The COACH preview (coach-session) sees everything in the review step — asymmetric by design. Today's preview-scores fix completes the coach side.**
**(2) ACCESS: leader cannot enter the Executive Impact System until `is_active_coaching` (set only by Activate, gated on debrief_completed_at). Prefill writes wizard data WITHOUT granting access.** Decisions: hard gate; report flow only for now, recommend other areas (send-invites) after it's proven. | M | ⏳ queued — next build | mockup approved; access gate at `client.html:3577`, `activate-sprint.js` |

### P1 — Two-tier access: self-service (debrief) vs coached (paid) (added 2026-07-14) — DECIDED, SPEC LOCKED

**Alex DECIDED the model 2026-07-14 — not an open question. Build it (fresh session — access-control, test before merge).**

THE MODEL — two independent 90-day clocks:
- **Debrief complete → self-service Executive Impact System access, 90 days from the debrief date.** Automatic, no payment. Leader can run the 90-day plan themselves in the system.
- **Within 7 days** of debrief → leader can buy discounted coaching.
- **They pay → Alex clicks Activate → coaching 90-day clock starts from the ACTIVATION date** (pay on day 6 → coaching runs 90 days from day 6). Coaching layers on top of self-service access.

CURRENT REALITY (verified 2026-07-14): access + coaching are ONE switch. `client.html:3577` gates entry on `is_coaching_client`, set ONLY by Activate (`activate-sprint.js`). Debrief-complete grants no access. No self-service path exists yet. **Confirmed: all JMAA leaders already have client records (`diagnostics.client_id` populated), so NO account provisioning needed — this is flags + clocks + gate logic.**

BUILD (exact):
1. **Migration:** add `clients.system_access_start_date` + `system_access_end_date` (the self-service clock; distinct from existing `coaching_program_start/end_date`).
2. **Debrief-complete action** (`markDebriefComplete` / server): set `system_access_start_date = debrief date`, `system_access_end_date = +90 days`. Automatic.
3. **client.html access gate (~3577):** grant entry if `today ≤ system_access_end_date` (self-service active) OR `is_coaching_client`. Self-service gets wizard + 90-day plan; coaching-only features (sessions, pulse cadence, coach messaging) STAY gated on the coaching flags.
4. **Activate:** unchanged — sets coaching flags + coaching clock from activation date, on top.
5. **Preserve the two invariants above** (visibility until publish; no early access).
ACCEPTANCE: seed 3 test clients — self-service active (debrief done, no pay), coaching active, expired self-service window — verify each sees the right portal state on preview BEFORE merge. Ties into deferred pricing/credit work (the 7-day discount window is the same credit window). | M | ⏳ **queued — next focused build**

### P1 — LLM provider independence (added 2026-07-14, ALEX HIGH PRIORITY)

**Alex's explicit strategic requirement: the system must not be locked to Anthropic. He needs to be able to swap the AI provider (OpenAI/Codex, Gemini, whatever comes next) with an API/config change, not a rewrite.**

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-L1** | **Anthropic is hardcoded in 10 call sites across 7 files** — `ask.js` (3), `coach-data.js` (2), `diagnostic.js` (1), `diag-portal.js` (1), `portal-data.js` (1), `testimonial.js` (1), `workshop-data.js` (1). Each hardcodes the URL, `x-api-key`, `anthropic-version`, request shape, and `.content[0].text` parsing. Swapping providers today = editing all 10. **Fix: one adapter `api/llm.js` exposing `llm({system,prompt,maxTokens,model})`; provider chosen by `LLM_PROVIDER` env var; provider-specific request/response shapes normalized inside. After: switch = one env var.** Prompts already live in `coach_prompts` (DB, not code) as of P1-R1, so prompts move with the provider too. | L | ⏳ **queued — HIGH PRIORITY, dedicated session** | grep 2026-07-14: 10 direct `api.anthropic.com/v1/messages` calls |

### P1 — Report generation → library prompts + in-house PDF (added 2026-07-14)

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-R1** | **Generators ignored the AI Studio prompt library.** All 6 hardcoded their system prompt; `coach_prompts` was never read by any generator — only by the AI Studio CRUD. Alex's edited v2 "Individual Diagnostic Report" prompt (active, saved 7/14) drove nothing. Wired `generate-report` to read the library via `getLibraryPrompt(name, fallback, format)` with safe fallback; made it output-format aware (text → `<pre>`-wrapped so no renderer blanks; html → cover + heading check). | M | ✅ Done 2026-07-14 (`feature/library-prompts`) | `coach_prompts` has 4 active rows; grep showed 0 generators reading them |
| **P1-R2** | **Wire the other 5 generators to the library + seed missing rows** (Team Report, Kickoff Brief, Interview Summary, report-section, plan-prefill, rec). Same `getLibraryPrompt` pattern. Seed `coach_prompts` for the 4 with no entry so every generator is AI-Studio-editable. | M | ⏳ queued — dedicated session | 6 hardcoded consts in `api/diagnostic.js` |
| **P1-R3** | **Report Packet → formatter JSON.** Make the packet emit the exact JSON schema `gps_report_formatter_v2.py` consumes, so the manual "paste prose, hand-map to JSON" step collapses to "download JSON, run formatter." Same JSON the future Python endpoint will take — not throwaway. | M | ⏳ queued | skill schema in `gps-diagnostic-report-formatter-v2` |
| **P2-R4** | **Port reportlab formatter into the portal (the real in-house PDF).** The portal renders HTML→PDF, which can't match the reportlab typesetting (score bars, colour zones, red cells, cover). Deploy `gps_report_formatter_v2.py` as a Vercel **Python** serverless function; portal POSTs report JSON, gets the branded PDF back. Same script, same quality, now automatic + scalable for sub-coaches. Own focused session. | L | ⏳ queued | reportlab is Python; portal is Node — needs a Python function |
| **P2-R5** | **Post-generation report editing — structured source of truth + AI-assisted edits (added 2026-07-15, Alex).** Today there are TWO report artifacts that can drift: the editable on-page report (`report_doc`, changed via "Edit report sections"/"Edit results-page words") and a **separately-uploaded static PDF** (`report_pdf_url`, built in Claude). On-page edits do NOT flow into the PDF; the PDF can't be restructured in-system at all — to change it Alex must edit in Claude and re-upload. **Depends on P2-R4:** first make the structured report the single source of truth and generate the PDF *from* it, so one edit updates both surfaces. **Then** build AI-assisted editing in two modes: (1) inline "AI: revise this section" — select a section, describe the change, it rewrites just that one, coach accepts/rejects (safer, surgical); (2) broader conversational "talk out the edits" for restructures. Guardrails, non-negotiable: every AI edit must respect the Rater Confidentiality Standard (can't reintroduce a suppressed group/verbatim) and must re-trigger the review-before-publish gate (edited report re-locks publish, `report_reviewed_at`). Route through the provider-independent LLM adapter (P1-L1) so editing isn't Claude-locked. Removes Alex's dependency on a live Claude connection to adjust reports. **Propagation model (Alex 2026-07-15):** consistency comes from ONE stored source with many views, never from copying an edit into each page. (a) **Scores** are already single-source (survey data) → identical on leader page, PDF, sponsor page automatically; narrative edits must NOT move scores (editing a score = editing data, out of scope). (b) **Narrative** edits update the leader page + generated PDF together (both render from the structured report). (c) **Sponsor Decision Room is a filtered projection, NOT a full mirror** — it shows a confidentiality-limited subset + sponsor-only authored content (coach summary, actions); propagation to it must **re-apply the confidentiality filter every time** so an edit can never push suppressed detail across the wall. (d) Every edit re-locks publish → back through Review; sponsor view re-renders live from the same source, so no separate "re-publish to sponsor" step. | L | ⏳ future (not before P2-R4) | Alex 2026-07-15: "how do I make structural adjustments to a report once generated… I may need AI functionality inside the Executive Impact System so I can talk those edits out"; + "we don't wanna change something one place and not change in other places" |

### P0.5 — Structural prevention (stops the next P0)

- **Deploy is a denylist → every new file is public by default.** How BOTH P0-1 and P0-3 escaped. Move to an allowlist deploy (explicit `public/` set) **or** add a pre-push check that flags any newly tracked non-HTML/JS file. Highest-leverage prevention in the audit. — M

### P1 — Decision Room reflexive lens: server payload (client render DONE; finish tonight vs Rosa's real data) (added 2026-07-15, Alex)

Client rendering is built and merged-ready in `decision-room.html`: `renderSponsorSelf(DATA.sponsor_self)` + `renderMirror(DATA.sponsor_mirror)`, wired in Rosa's self-zone right under the Snapshot, both **dormant** (return '' unless the server sets their data — so the live room is unchanged until then). Remaining work is the **server payload in `sponsor-data.js`, action `team`** — build + test against Rosa's real data once her diagnostic closes (2026-07-15), NOT blind:

1. **`DATA.sponsor_self`** — only when the viewing sponsor is themselves a rated leader whose diagnostic is COMPLETE. Resolve via `sponsor.linked_client_id` → that client's diagnostic → latest `scores_json`. Shape: `{ name, tp3, trust, proactivity, productivity, bench, report_url (their diagnostic-leader link, coach-session NOT required since it's their own), pdf_url }`. Null otherwise. Never blend into the team composite.
2. **`DATA.sponsor_mirror`** — surface where the sponsor's OWN (supervisor) read diverges hardest from the composite. For each team member, read `scores_json.by_group.supervisor` (the sponsor's own ratings — attributable + it's their own data, so NO confidentiality wall issue) vs the composite `tp3_index`. Rank by |gap|, take the top 2–3. Shape: `{ connections:[ {title, teamLabel:'Their team', teamVal, selfLabel:'How you rate them', selfVal, read, ask} ], sprint_cta_url }`. `read`/`ask` are coach-framed openings (LLM-generated via the library prompt, or templated) — forward-facing, never verdicts. **Confidentiality:** only expose the supervisor's own numbers + the composite; never expose other suppressed groups' breakdowns. Gate the whole thing to the sponsor-is-the-supervisor case.
3. **JMAA truth to validate against** (the split the mirror must catch): Kimberly composite 3.96 but Rosa rates her **2.37**; Jana composite 3.38 but Rosa rates her **4.25**. Proactivity is the team's weak pillar (CEO-bottleneck = Alex's niche). Full context: `Decisions/2026-07-15 - JMAA Coaching Offer Strategy.md` (vault).
4. Personal sprint CTA in the mirror is a **soft conversation-opener** ("Let's talk about your sprint"), distinct from the team sprint at the bottom. — M — client done; server queued for tonight.

### P1 — This week

- **Report PDF replace showed the OLD file (cache) — FIXED on branch 2026-07-15.** The uploaded report lives at a fixed path `<id>/report.pdf`; a replace overwrites it at the *same* public URL (`cache-control: max-age=3600`), so the CDN + browser kept serving the stale copy. Michael/Patrick/Kimberly and everyone else re-uploading saw no change. Fix: `uploadFinalReport` now stamps `?v=<Date.now()>` on the stored `report_pdf_url` (and the client mirror) every upload, so a replacement gets a fresh address. Immediate relief applied in prod DB (versioned the 4 JMAA chiefs' URLs to their real object timestamps). ⚠ **Until `feature/library-prompts` merges to main, production still runs the OLD upload code** — a fresh replace there will re-introduce the stale URL; re-version via SQL or merge to close it. — ✅ code done (branch), prod data patched.

- **Coach dashboard crash still live** — `Cannot read properties of null (reading 'remove')`, 8 hits July 1; guard the inline `getElementById(...).remove()` handlers in `coach.html` (4330, 4779, 9051, …). — S — *Verified (client_errors)*
- **Re-skin the three assessment pages** (`feedback.html`, `survey.html`, `diagnostic-survey.html`) to the real GPS palette (`#004369` / teal `#01949A` / red `#DB1F48`), add the logo, strip all emoji. First thing a stakeholder sees; currently looks like a cheaper, different company. Cheapest trust win in the system. — S–M
- **Fix wizard step-count contradiction** — top bar "STEP 1 OF 8" vs inner "Step N of 7" (`client.html` step badges + `wizSteps` render). — S
- **Restore mobile wizard step context** — at ≤480px all step labels hide (`client.html:417`); keep one persistent "Step N of 7 · <label>" line. — S
- **`business_outcome_goal` leaks to client browser** (UI-only gate) — return an explicit column allowlist from `get-client.js:463`. — S

### P2 — Show the uploaded report's file name (added 2026-07-15, Alex)

After uploading a report PDF, the upload card / step 2 shows only "Report on file" — not the actual file name. Alex: "we should be able to see the name of the report once it's uploaded… that would help me so I'd know what's being shown versus clicking into it each time." Store the original filename on upload (`_finalReportFile.name` → new `report_pdf_filename` column, or reuse a field) and display it next to "View PDF" / "Replace PDF" in the stepper's step 2. Small. — S

### P2 — Leader photo on the report cover + on-portal report header (added 2026-07-15, Alex)

The coach-set leader photo (`clients.avatar_url`) now shows in the leader's Executive Impact portal header (diagnostic-leader) and the coach console. Extend it to the two remaining surfaces from the profile-photo sandbox: (1) the **report cover** — since the deliverable PDF is built in Claude, add the avatar to the report-cover template / formatter (`gps-diagnostic-report-formatter-v2` + the future in-house PDF P2-R4) so the face is on the deliverable; and (2) the **on-portal report view header** (the rendered report inside client.html / diagnostic-leader report mode) so the photo carries through the report, not just the welcome header. Pull `avatar_url` where the report renders. — S–M

### P2 — Coaching-side (coach console) page-by-page UX + visual pass (added 2026-07-14, Alex)

Alex has spent his polish budget on the *client* side; the *coaching* side (`coach.html` and the coach-facing tabs/modals) now needs the same treatment. Go page by page / tab by tab through the coach console and make each screen clean, executive-grade, visually consistent, and — above all — **intuitive enough that a new admin (his EA) can operate it without being walked through**. Not just Alex's muscle memory.

- Run **both** skills together on each screen: `ux-experience-auditor` (clarity, task flow, "what do I do next," error/empty states) **and** `gps-visual-conversion` (visual craft, hierarchy, spacing, colour restraint, premium feel). Recommend-only; implement via `gps-portal-safe-build`.
- Cover every coach surface: client list / dashboard, the diagnostic tabs (Overview, Raters, Survey Status, Questions, **Report** — just redesigned, Emails), the Coaching Sessions card, Activate-sprint + debrief flow, sponsor/Decision-Room controls, AI Studio / prompt library, messages, profile/settings, and all modals.
- Bias to **simple**: fewer buttons visible at once, one obvious next action per screen, plain labels over jargon, consistent button styling, no orphaned/legacy controls. Target reader = a competent EA on day one.
- Deliverable per screen: scored rubric + before/after mock + prioritized fix list, folded back into this Master Build List by priority. — L (multi-session; schedule it)

**📱 MOBILE-FIRST IS A HARD REQUIREMENT ON EVERY ITEM BELOW** (Alex, 2026-07-18) — he runs the console from his phone on the go (pushing sends, reading data). Every coaching-side change must be verified on a phone frame (use the built-in Mobile Preview), not just desktop. "Works on desktop" is not done. This applies to all P1-UX / P2-UX items and the Assessments split.

**✅ BATCH 1 built + preview-verified 2026-07-18** (branch `coach-nav-batch1`, mobile-checked via DOM flex-wrap): Messages promoted to top-level tab (P1-UX2 ✅); Communication group retired, Email Log/Ask Alex Log/Access & IT + Templates moved into Settings (P1-UX1 ✅); Workshops/Assessments split into two filtered sub-tabs — step 1 of P2-UX9 ✅; loud red Delete on Workshops quieted to outline (P1-UX8 ✅, Workshops side; Teams side was already outline). **Deferred:** P1-UX3 group descriptors (only works as desktop tooltip; belongs in the P2 mobile-friendly tab-bar redesign). Awaiting Alex's merge to main.

**✅ IA-level review done 2026-07-18** (GPS Tech/Portal Agent) — full writeup in `COACHING_SIDE_REVIEW_2026-07-18.md` (Tool Creation folder). Scores: Admin/Coach UX **B–**, Visual **B–** (provisional, needs live-session look), Technical/long-term **C+**. Root problem is findability, not features: **9 top-level groups / 17 destinations**, inconsistent nav depth (6 groups jump to a page, 3 open a second sub-tab row), and 3 miscategorized items. Fix items broken out below. Page-by-page visual pass (the original L-scope above) still stands as a follow-on once the IA is simplified.

| # | Item | Effort | Status | Evidence |
|---|------|--------|--------|----------|
| **P1-UX1** | **Move 3 miscategorized nav items.** Pull *Access & IT* and *Ask Alex Log* out of the **Communication** group into **Settings**; they're config/analytics, not comms. Removes the worst "why is this here" moment. | S | ⏳ queued | coach.html subnav-comms (lines ~894-900) |
| **P1-UX2** | **Promote Client Messages to a top-level "Messages" tab** (keep the existing unread badge). The one channel touched daily shouldn't be buried as a sub-tab. | S | ⏳ queued | coach.html subnav-comms |
| **P1-UX3** | **Add a one-line descriptor (or icon) per top-level group** so the destination is obvious before the click. | S | ⏳ queued | coach.html section-nav (lines ~866-875) |
| **P1-UX4** | **Reconcile "Today" vs "Insights" naming** so it's clear which is the action list and which is analytics. | S | ⏳ queued | grp-today / grp-insights |
| **P2-UX5** | **Consolidate 9 groups → 6-7** per the proposed map (Today · Clients · Diagnostics & Teams · Workshops · Organizations · Messages · Settings), clustering Settings into "Configuration" vs "Activity & Logs". Needs a premortem (structural nav change). | M | ⏳ queued | review doc §Proposed map |
| **P2-UX6** | **Shared style-token system (CSS variables)** to replace the scattered inline hex/spacing — prerequisite for a consistent premium visual pass. **Increment 1 done 2026-07-18** (branch `coach-color-tokens`): inventoried 245 distinct hex; added 9 semantic tokens (`--text-muted/-faint`, `--border`, `--line`, `--surface-2`, `--slate`, `--ok`, `--warn`, `--err`) + reused existing; script-migrated the top 18 colors = **713 raw hex → tokens, appearance-identical** (values == old hex). Safety: no canvas/SVG color contexts; theme-color meta preserved; no circular var defs; JS sweep clean. **Remaining increments:** long-tail (~225 colors, 1-5 uses each) + merge near-duplicate slates (needs visual judgment) + spacing tokens. | M→L | ✅ increment 1 shipped 2026-07-18 (ba4a0c3). **Increment 2** (branch pending): merged 4 near-identical slate typos (#8a99a0/#8a97a0/#8a98a0/#8a97a6, 28 uses) → `--slate-2`; established the **governance system** (see P2-UX10). Long-tail status tints intentionally left (contextual, not brand-primary). | coach.html |
| **P2-UX10** | ✅ **Brand-governance system — Done 2026-07-18** (Alex: "how do we make sure new builds stay within branding, so we don't end up at 245 again"). Three parts, all shipping on the increment-2 branch: (1) **`BRAND_TOKENS.md`** — single source of truth listing every approved token + when to use it; (2) **`scripts/color-guard.py`** — a ratchet lint that baselines the current raw-hex set (coach.html: 214 distinct) and flags any NEW hardcoded color a future change introduces (run before staging HTML); (3) **CLAUDE.md rule** — "use brand tokens, never hardcode hex" so every future build defaults to tokens. Extend the baseline to client.html / decision-room.html / sponsor.html / survey.html as those get tokenized. | M | ✅ Done 2026-07-18 | BRAND_TOKENS.md, scripts/color-guard.py, CLAUDE.md |
| **P2-BRAND1** | **Branding panel (Settings → Branding)** — Alex 2026-07-18, "put it in the list to build later, not a priority today." A no-code screen with color pickers that save the brand palette to the account and inject it as `:root` overrides across the portal, so Alex can rebrand without a code change. Prereqs mostly done (token migration). Build later; needs a premortem (touches page load) + a decision on storage (settings table) and which tokens are user-editable. Roll out console-first. | L | ⏳ backlog (build later) | depends on P2-UX6 token migration |
| **P2-UX7** | **Begin modularizing coach.html** (~14k-line single file). Gradual extraction, not a rewrite. 6-month handoff/maintainability risk. | L | ⏳ queued | coach.html size |
| **P1-UX11** | **Polish the individual client profile** (Alex 2026-07-18, "doesn't look too nice/great, especially each profile"). Live look at /coach → Clients → a profile found: (1) **emoji icons in the left sidebar nav** (📊🔬🎯✅👥⚙️) read as amateur and clash with the brand — replace with clean simple icons or plain text labels (highest-impact fix, affects every profile tab); (2) **duplicated identity block** — name/avatar/org appear in the navy header AND again in the Summary card just below; de-dupe; (3) **flat dead-grey metric progress bar** even at 0% — use `--ok` green as it fills. All mobile-verified, all via tokens. Small-to-medium; the emoji swap alone is a quick high-impact win. | M | ✅ desktop polish shipped 2026-07-18 (SVG icon nav replacing emoji + de-duped identity strip + softened metric bar, verified on prod). **Mobile follow-up** (Alex, on his phone: the sidebar eats half the screen) — on ≤680px the section nav collapses to a full-width **dropdown** at the top and the content gets the whole page (native `<select>` synced to `switchProfileNav`, sidebar hidden). Branch `coach-profile-mobile-dropdown`; JS sweep + color-guard clean. | live: /coach#clients profile |
| **P1-UX8b** | **Extend the quiet-Delete treatment to the Leader Diagnostics list** (found during 2026-07-18 verify). Teams + Workshops now use the quiet outline Delete (P1-UX8 ✅), but the Leader Diagnostics list row still renders a loud solid-red Delete — make all three consistent. Small, low-risk. | S | ⏳ queued | live: /coach#diagnostics |
| **P1-UX8** | **Demote destructive "Delete" buttons** on the Teams (Decision Room) and Workshops & Assessments lists. Live check 2026-07-18: every row renders a solid red **Delete** one click away, with Archive. Change to a quiet icon/overflow menu + confirm dialog so a misclick can't nuke a team/engagement. | S | ⏳ queued | live: /coach#decisionroom, #workshops |
| **P2-UX9** | **Split Workshops and Assessments into two separate destinations** (Alex, 2026-07-18 — "they're different, they shouldn't pull together"). Ground truth: one `workshops` table + one section, split only by `engagement_kind` ('workshop'/'assessment'); creation is already bifurcated (two "+ New" buttons) and the Today feed already badges them, but the nav + list conflate them. **Recommended step 1 (shallow, no migration):** keep the top-level **Workshops & Assessments** group but give it two sub-tabs — **Workshops** \| **Assessments** — each filtered by `engagement_kind`, each with its own list + create button + a clear Type badge. Mirrors the existing Diagnostics & Teams (Leader Diagnostics \| Teams) pattern, so it separates the functions without widening the top bar. **Step 2 (CONFIRMED — Alex 2026-07-18: "they're meaningfully different, plan separate flows"):** build Assessments toward its own domain with a distinct setup / scoring / output flow, not just a filtered view. Needs a premortem + a short design spec before building (structural). Also: move the "Sponsor Schedule-a-call link" field off the list page into Settings. Both steps mobile-verified. | M→L | ⏳ queued (step 1 ready to build; step 2 needs design spec) | live: /coach#workshops |

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

### Goal + Vision anchoring for Ask Alex (Executive Impact System) — *ADDED 2026-07-02, not started*

Full verbatim spec in Supabase `portal_context.backlog_goal_vision_anchoring`. Four features, safe-build, mobile-first, do **not** gate access:

1. **Goal + Vision display block** atop the diagnostic / Ask Alex area — the 90-day goal (`clients.goal_statement`) shown **read-only** with a lock and "Set with your coach" + a "Request a change" link; the vision shown as one line with a pencil that opens the guided editor. Two lines, not a form.
2. **Ask Alex anchoring** — inject goal, vision (verbatim), priority behaviors, and TP3 focus into the system prompt. Open each answer by naming the goal/vision in the leader's own words ("because you told me this matters," never "based on your inputs"); close with one concrete next step tied to the goal + this week's check-in.
3. **Guided, specificity-forced vision capture** used in **both** the diagnostic self-assessment and the editable vision field — 3 micro-prompts, weak-vs-strong example, synthesize to one line, then an **AI specificity gate** (future state of team/org + observable outcome + more than a noun); after 2 failed revisions, accept but flag for coach review.
4. **Goal lock + change-request flow** — leader can never edit `goal_statement`; "Request a change" notifies the coach (sponsor-visible for sponsored engagements); coach edits in the plan wizard; log who/when.

Schema: reuse `diagnostics.self_three_year_vision`; add `clients.vision_statement`, `vision_last_edited_at`, `vision_flagged_for_review`, `goal_change_requested_at`; `goal_statement` editable by coach/admin only. **Do not** let the leader edit the goal; **do not** accept a one-word/credential-only vision.

### Doc hygiene

- `GPS-PORTAL-ROADMAP.md` still lists **PWA as "planned"** — it's shipped. Prune roadmap/backlog so this list stays the single source of truth.
- **P3 — `GPS_SURVIVAL_PACKAGE.md` (local) is stale against the live schema.** (added 2026-07-13, nightly-backup run) The file map (Section 3) and data model (Section 7) still describe an older table set (`assessments`, `surveys`, `coach_notes`, ~50 migrations) vs. the live system, which has 65 tables and 97+ migrations as of tonight. Not urgent — the nightly backup's Drive copy now refreshes Section 7 live from Supabase each run, so the reconstruction data itself isn't stale, only the narrative file map/architecture prose in the local working copy. Do a full rewrite of Sections 3 and 7 next time portal docs are touched.

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

## Section 4 — Pending (added this session, not yet built)

### Active / In Progress
| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| **Diagnostic nurture engine** — 5-touch email sequence for diagnostic-only leaders (no sprint purchased); auto-triggered on `report_final` status | P1 | M | Keeps pipeline warm; drives sprint conversions |
| **Renewal automation** — approaching end-of-engagement email sequence (week 10+) | P1 | M | Retention + expansion play |

### Security hardening batch (approved, not yet built)
| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| HTTP security headers in `vercel.json` (CSP, X-Frame-Options, HSTS, etc.) | P1 | S | Standard hardening |
| Rate limiting on Anthropic-calling endpoints (Ask Alex, run-prompt, email gen) | P1 | S | Prevents runaway Anthropic spend |
| Set hard daily caps + billing alerts in Anthropic and Resend dashboards | P1 | S | Alex action (dashboard config) |
| Server-side input validation sweep — type checks, length limits, sanitization on all write endpoints | P1 | M | Defense-in-depth |
| Error message audit — ensure no raw Supabase errors, stack traces, or schema details reach the browser | P1 | S | Prevents info leakage |
| Privacy policy page (GDPR/CCPA minimum) | P2 | S | Legal baseline |
| Tighten CORS — restrict `/api/*` to `portal.gpsleadership.org` and preview domains only | P1 | S | Reduces attack surface |

### Feature builds (approved, not yet built — on `feature/metric-checkin-v1` branch)
| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| Wizard structured metric config — coach sets type/baseline/target/unit in coach.html; stored as JSON | P2 | M | Replaces hardcoded metric field |
| Metric-aware one-tap check-in in client.html — shows current metric, last entry, one-tap on-track buttons | P2 | M | Core engagement feature |
| Commitment modal + streak in client.html — weekly commitment capture + streak display | P2 | M | Builds habit and ownership |

### Other pending
| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| Sponsor bulk payment flow — sponsor pays for multiple team members transitioning to coaching | P2 | M | Needed before JMAA engagement |

---

## Section 5 — Shipped since July 1, 2026

All items below were built, tested, and pushed to `main` after the July 1 audit.

| Item | Shipped | Notes |
|------|---------|-------|
| Rename "Executive Impact Portal" → "Executive Impact System" everywhere (HTML, API, emails) | July 2026 | Brand consistency fix |
| Reschedule message type — new `message_type` enum value, dropdown option in client.html, Resend notification | July 2026 | Client communication feature |
| Client message → Resend email to Alex on every message | July 2026 | Ensures no message goes unseen |
| `refreshMsgBadge()` called on `loadDashboard()` — Today flags load on page open | July 2026 | Bug fix |
| `msg-overdue` cron + `businessDaysSince` + upgraded Today card visuals | July 2026 | Coach accountability feature |
| AI reply draft feature — `coach-msg-draft` action, Regenerate button, auto-dismiss on typing | July 2026 | Coach productivity |
| Inbox coaching v2 — Cmd+Enter send, check-in staleness nudge, security cleanup (`data_*.json` removed) | July 2026 | Branch `feature/inbox-coaching-v2` |
| Reminders runtime config — `reminder_config` table (migration v79), coach UI subtab, hourly cron | July 2026 | Replaces hardcoded reminder logic |
| Smart reminders — personalized to `checkin_day`, skips weekends | July 2026 | Engagement improvement |
| Coach prompts + AI Studio tab — `coach_prompts` table (migration), prompt library, run interface | July 2026 | Coach productivity |
| Auto-inject client context into prompt runs + `max_output_tokens` control | July 2026 | AI Studio improvement |
| Today page dismiss/snooze on all notification flag cards | July 2026 | UX improvement |
| Wizard reset + Plan Review reset buttons in coach.html diagnostic card | July 2026 | Ops / client management |
| Diagnostic credit window: 30 → 7 days everywhere | July 2026 | Business rule correction |
| Parallelize `sponsor-data.js` — `Promise.all` member loop + trailing queries | July 2026 | Performance improvement |
| Decision Room: single API call init (was 2 calls) | July 2026 | Performance improvement |
| `teams` returned in `team` action of sponsor-data.js | July 2026 | Bug fix |
| Sergio's wizard state reset to fresh start | July 2026 | Client prep for debrief |
| Marcus Holt demo diagnostic report (full content + PDF) | July 2026 | Demo / sales asset |

---

## Section 6 — Ops / non-code (Alex actions)

- **Upgrade Supabase free → Pro (~$25/mo)** — for automatic DB backups / point-in-time recovery and to stay under storage/bandwidth ceilings as report PDFs accumulate. Worth doing before a major engagement.
- **Migration label cleanup** — three different migrations are tagged "v66" (`v66_diagnostic_kickoff_fields`, `v66_survey_schedules`, `v66_structured_report_doc_and_business_outcome`). Renumber the next one to avoid ambiguity.
- **Env var rotation** — see Section 1, items 1–2.
- **Move this file into the gps-portal repo** at `docs/MASTER_BUILD_LIST.md` and commit. Version-controlled alongside the code. Delete the Tool Creation copy once moved.
- **Archive `GPS-PORTAL-ROADMAP.md` and `GPS_PORTAL_BACKLOG.md`** — superseded by this doc.
- **Deprecate `council.portal_roadmap`** in Supabase — 4 items, all captured here.
- **P3 — Clean up + commit the "Tool Creation" folder.** The repo working dir has accumulated loose scratch files (sandbox HTML experiments, old migration SQL, review markdowns, `.fuse_hidden*` junk) mixed in with real governance docs (`CLAUDE.md`, this build list, retired backlog) that have never been committed. Sort keep-vs-delete, make sure internal `.md` docs are `.vercelignore`'d so they don't serve publicly, then hand Alex a clean commit (he runs git). ~20 min, housekeeping.
- **P3 — SMS follow-ups (after A2P campaign approval).** The SMS send path (`api/twilio-sms.js` + `send-reminders.js`) and the opt-in checkbox are built and merged. Remaining polish: (1) capture a `sms_opt_in_at` consent timestamp on the client for TCR audit proof (migration + save in portal-data/client.html); (2) dedicated SMS delivery logging (currently counted in the run response only, not persisted per-message); (3) full end-to-end send test once the campaign shows Registered, the `TWILIO_MESSAGING_SERVICE_SID` env var is set, and the number is attached to the Messaging Service — test with one opted-in TEST client + Alex's own mobile.
- **P3 — Adopt a dedicated `/sandbox/` folder convention for experiments.** Going forward, every throwaway experiment page/file gets created inside a single `sandbox/` folder in the repo (git-ignored + vercel-ignored) so scratch work never clutters the real tree and can be wiped anytime without risk. Add the rule to `CLAUDE.md` and the `gps-portal-safe-build` skill once the folder exists.

---

## Section 7 — Migrated from GPS_PORTAL_BACKLOG.md (June 5, 2026 — now retired)
_These open items lived only in the old backlog; pulled in here so nothing is lost. `GPS_PORTAL_BACKLOG.md` is now a pointer to this file._

- **P2 — In-portal question review & approval (kills the email back-and-forth).** Coach clicks
  "Send for review" on proposed/AI questions → sponsor/leader (or POC if present) gets a
  token-gated, mobile-first review page: each question has Approve / Request change (comment) /
  inline Edit, plus Approve all; standard core is read-only. On submit: update question status,
  advance workshop status (sponsor_review → ready), notify coach. Reuse `workshop_questions.status`;
  assessment uses the `workshop_sponsors` link, diagnostic uses `leader_token` for custom G1/G2.
  New actions: `get-review-questions(token)`, `submit-question-review(token, decisions)`,
  coach `send-questions-for-review`. **Phase 1** = read-only shareable preview link (low effort,
  removes most friction); **Phase 2** = full approve/request-change/edit + status flow + notifications.
- **P2 — Per-person logins / named coach-side accounts (individual auth).** Today = single shared
  coach password → one signed session. `admin_accounts` (hashed passwords, is_active) is the
  foundation. Build = named accounts + per-user sessions + a light who-did-what audit log.
  **Trigger, not a date:** the first second human in the coach console (EA/VA/associate), OR the
  first gov/enterprise security review asking "who can access our data." Keep clients frictionless
  (token links, no password); add named logins only on the COACH/admin side.
- **P3 — Inline coach editing of per-member Decision Room cards** (focus / succession). Generation
  fills them; quick inline edit by the coach is a fast-follow.
- **P3 — SMS text nudge for missed check-ins.** Email nudge already shipped. Needs an SMS provider
  (Twilio): account, API keys in Vercel env, client mobile numbers, opt-in consent. Wire the SMS
  send alongside the email on the same "Send reminder" button, with editable text.
- **P3 — Legacy 360 CSV importer (#48).** Ingest past diagnostics from CSV: text-match the question
  columns (don't trust numbering), "Self" row identifies the leader, map the 1–5 items + 1–10 overall
  impact, capture START/STOP/CONTINUE verbatims. Store and chart, clearly labeled as a prior/different
  instrument.
