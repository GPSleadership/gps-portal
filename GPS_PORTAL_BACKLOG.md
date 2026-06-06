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

## Done (recent)
- Decision Room: team-tied reports, branded-PDF model, AI recommendations (GPS-aligned,
  Edit/Reject/Approve → Show/Hide/Unapprove), content generation, succession/bench fix.
- Leader results page (1–5 scale) + diagnostic-tab fix; in-portal sponsor tab.
- Day 1 / Day 30 / Day 90 checkpoints; coaching-cadence attendance denominator;
  ad-hoc external feedback link; email check-in nudge; multi-select client filters.
