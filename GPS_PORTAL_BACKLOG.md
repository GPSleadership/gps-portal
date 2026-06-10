# GPS Portal — Backlog (found, not yet done)

Ideas and gaps discovered while building, parked for later. A recurring reminder
surfaces the open items so nothing gets lost. Move things to "Done" as we ship them.

_Last updated: 2026-06-05_

## Open
- [ ] **SMS text nudge for missed check-ins.** The email nudge shipped. Texting needs an
      SMS provider (e.g. Twilio): an account, API keys added to Vercel env vars, client
      mobile numbers, and opt-in consent. Then wire the SMS send alongside the email on the
      same "Send reminder" button, with editable text.
- [ ] **Legacy 360 CSV importer (#48).** Ingest past diagnostics from CSV: text-match the
      question columns (don't trust numbering), "Self" row identifies the leader, map the
      1–5 items + the 1–10 overall impact, capture START/STOP/CONTINUE verbatims. Store and
      chart, clearly labeled as a prior/different instrument.
- [ ] **Coach UI to set each client's coaching cadence** (weekly / biweekly / monthly).
      It drives the attendance denominator; right now it's only set directly in the database.
- [ ] **Inline coach editing of per-member Decision Room cards** (focus / succession).
      Generation fills them; quick inline edit by the coach is a fast-follow.
- [ ] **(Optional) General, project-agnostic "safe build" skill.** Deferred — only needed
      if a second live external-facing portal appears.
- [ ] **Per-person logins / named user accounts (individual auth).** Today it's a single
      shared coach password → one signed session. The `admin_accounts` table (hashed
      passwords, is_active) is the foundation. Build = named accounts + per-user sessions
      (session token already carries a role; add a user identity) + a light audit log of
      who did what. **Trigger, not a date:** the first second human in the coach console
      (EA / VA / associate), OR the first government/enterprise client whose security review
      asks "who can access our data" — whichever comes first. Given the gov/mid-market
      pipeline (e.g. JMAA), the client-driven trigger may be 1–2 engagements out.
      _Open tension Alex is weighing: more auth = more security + audit trail, but also more
      friction, and people already have too many passwords — friction lowers adoption. Likely
      resolution: keep it frictionless for clients (token links, no password — unchanged);
      add named logins only on the COACH/admin side, where the user count is tiny and the
      audit trail actually matters. That gets the security without taxing client adoption._
- [ ] **Engagement roles: Sponsor vs POC (point of contact / coordinator).** CONFIRMED design
      (2026-06-09): a person is attached to an engagement with a ROLE, not a fixed profile.
      **Sponsor** = results owner (dashboard, TP3, NPS, findings, recommendation, report) AND may
      do logistics. **POC** = logistics owner (upload roster/participant/rater list, review &
      approve questions, see status/timeline) but **NEVER sees results or report data.** One
      person can hold both. Applies to **both** workshops/assessments AND diagnostics (on a 360
      the POC is the HR/chief-of-staff coordinator who provides the rater list + reviews custom
      questions but must not see who said what — this is a CONFIDENTIALITY feature, the headline
      selling point). Data: `workshop_sponsors.role` + per-contact `access_token`; diagnostics get
      `poc_name/poc_email/poc_token`. Portal gates surfaces by role (POC token → logistics only;
      results require sponsor/leader). Backward-compatible: today's sponsor = "sponsor who also
      coordinates." (Migration v47.)
- [ ] **In-portal client/sponsor question review & approval (kills the email back-and-forth) — PHASE 2, full loop.**
      Routed to whoever owns logistics (POC if present, else Sponsor for assessments / leader-side
      coordinator for diagnostics).
      Today the coach generates questions and reviews them in the console; getting the
      client's sign-off is manual email. Build a tokenized client-facing review flow that
      works for BOTH products:
      - Coach clicks **"Send for review"** on the proposed questions → emails the sponsor/leader
        a link ("Your questions are ready — take a quick look").
      - **Review page (token-gated, mobile-first):** shows the proposed/AI questions clearly
        separated from the standard core; each question has **Approve / Request change (comment)
        / inline Edit**, plus an **Approve all**. Read-only on the standard core.
      - On submit: update question status (draft → approved, or → needs_edit with the client's
        note/edit), advance the workshop status (sponsor_review → ready), and notify the coach.
      - Reuse existing plumbing: `workshop_questions.status` already supports draft/approved/
        rejected; assessment uses the sponsor/`workshop_sponsors` link, diagnostic uses
        `leader_token` for the custom G1/G2 questions. New endpoint actions: `get-review-questions(token)`,
        `submit-question-review(token, decisions)`, and a coach `send-questions-for-review`.
      - **Phasing:** Phase 1 = a read-only shareable preview link (low effort, lets them SEE
        the questions in-portal instead of pasted into email). Phase 2 = full approve / request-
        change / edit-in-place + status flow + notifications. Phase 1 alone removes most friction.
- [ ] **Upgrade Supabase free → Pro (~$25/mo) for backups + reliability.** The portal's data
      and report PDFs live on the Supabase FREE plan today. It works, but: no automatic DB
      backups / point-in-time recovery (current backups are the manual local zips), and the
      1 GB storage + bandwidth ceilings will fill as report PDFs accumulate. Now that the
      portal is business-critical, Pro is worth it mainly for the automatic backups — worth
      doing before/around a major engagement, not for capacity.

## Done (recent)
- Decision Room: team-tied reports, branded-PDF model, AI recommendations (GPS-aligned,
  Edit/Reject/Approve → Show/Hide/Unapprove), content generation, succession/bench fix.
- Leader results page (1–5 scale) + diagnostic-tab fix; in-portal sponsor tab.
- Day 1 / Day 30 / Day 90 checkpoints; coaching-cadence attendance denominator;
  ad-hoc external feedback link; email check-in nudge; multi-select client filters.
