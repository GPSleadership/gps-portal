# Decision Room — Integration Guide (for the build thread)

**Audience:** the thread that will build the Decision Room into the live GPS Leadership portal.
**Written:** June 3, 2026, immediately after the Phase 1 security cutover went live.
**Read this before writing any code.** The Decision Room brief was written against the *old* portal architecture. The security model changed today. If you build to the brief's "anon key + RLS" assumption, you will build it wrong and re-leak the data we just spent a day closing.

---

## 0. THE ONE THING TO INTERNALIZE FIRST

The brief repeatedly says things like *"enforce private mode via Supabase RLS, the browser uses the anon key + RLS, the confidential row must be unreadable by the sponsor's session."* **That is no longer how this portal works.** As of today's cutover:

- **The browser never queries Supabase directly.** Every page (`client.html`, `coach.html`, `diagnostic-leader.html`, `diagnostic-survey.html`) now calls **token/session-validated serverless endpoints** that use the **service-role key** server-side. The anon key is dead for data access.
- **Every table now has RLS enabled with NO anon policies** — i.e. deny-all to the public key. The service role **bypasses RLS entirely.**
- Therefore: **RLS is no longer your access-control mechanism. The serverless endpoint is.** Because the endpoint runs as the service role (which bypasses RLS), RLS cannot be what decides "can this sponsor see this row." The *endpoint code* decides, based on the validated token and the engagement's confidentiality mode, what to put in the response.

**Restate the brief's security rule in the new model:**
> "The individual self-vs-raters data for a private engagement must be unreadable by the sponsor."
becomes
> "The **sponsor-data endpoint** must never *include* the self-vs-raters data in its response for a private engagement. The browser only ever receives what the endpoint returns, so if the endpoint doesn't send it, it does not exist on the client."

RLS stays enabled as a **backstop** (defense in depth: if a key ever leaks, the tables are still deny-all). But the **gate is the endpoint.** Build the gate in the endpoint. Never in page JS, never relying on RLS to scope per-sponsor.

This is the difference between "hiding a button" (what the brief correctly warns against) and "the data is never sent." Server-side omission is the real protection.

---

## 1. How the live portal is wired now (so you match the pattern)

Established, working patterns from Phase 1 — copy these, don't invent new ones:

| Concern | Pattern in the live portal |
|---|---|
| Public page identifies a user | A **token** in the URL (`?token=…`) — client portal token, diagnostic `leader_token`, rater survey token. |
| Coach identifies themselves | A **signed HMAC session** (`COACH_SESSION_SECRET`), issued by `coach-login`, stored in `localStorage`, sent in the request body. |
| Browser reads/writes data | Calls a serverless endpoint (`/api/portal-data`, `/api/coach-data`, `/api/diag-portal`) that validates the token/session, then runs the query with the **service key**, scoped in code. |
| Endpoint → DB | Helper `sb(path, method, body)` using `SUPABASE_SECRET_KEY`. |
| Tables | RLS enabled, **no anon policies** (deny-all). Only the service role reaches them. |

Relevant live files to read before building: `api/portal-data.js` (token→client scoping + column allowlist), `api/coach-data.js` (coach-session-gated; generic allowlisted proxy + dedicated sensitive actions), `api/diag-portal.js` (leader/rater token flows — **the closest analog to what you're building**). The Decision Room's sponsor endpoint should look like `diag-portal.js`.

Constraints that still hold: single-file vanilla HTML/CSS/JS, no build step; Vercel **Pro** (no function-count cap — you may add new `api/*.js` files freely); Resend for email; Anthropic for AI; `COACH_SESSION_SECRET`, `SUPABASE_SECRET_KEY` already set in Vercel.

---

## 2. Sponsor = a new first-class account type (build it like the leader token)

The sponsor is **not** a coaching client and must skip all onboarding (wizard, goals, plan, check-ins, Ask Alex). Model it exactly like the diagnostic leader: a token that routes to one read-only page through one endpoint.

**Build:**
- A **`sponsors`** table (or a `sponsor` role row): `id, name, email, sponsor_token (unique), confidentiality_default, active, created_at`.
- A **`sponsor_teams`** link (a sponsor can sponsor one or more teams): `sponsor_id, team_id, supervises_member_ids[] (or a join table), confidentiality_mode (Standard|Private) per engagement`.
- A new page **`decision-room.html`** served at a clean route (e.g. `/decision-room`), token-gated (`?token=<sponsor_token>`), **read-only, zero mutation controls**.
- A new endpoint **`api/sponsor-data.js`** — the security boundary. It:
  1. Validates the `sponsor_token` (service-key lookup; reject if unknown/inactive).
  2. Resolves which team(s) and which members the sponsor may see.
  3. **Enforces the hard feedback gate** (Section 4) before returning any team data.
  4. **Enforces confidentiality mode** (Section 3) by *omitting* gated fields from the response.
  5. Returns a fully-assembled, already-scoped payload. The page just renders it.

Mirror `diag-portal.js` for the token-validation + scoped-payload shape. Sponsor login can be pure token-in-URL (emailed link) like the leader page; no password needed unless you want a session.

---

## 3. Confidentiality "Private mode" — the security-critical piece, restated for this architecture

**What's confidential (Alex's rule): ONLY the individual diagnostic self-vs-raters scores** (the "Leadership Scores — Self vs. Raters" card) and any flag *derived from the confidential 360 raters*. Everything else — 90-day focus, stakeholder scoreboard, engagement, progress, stakeholder-based flags, team momentum, succession, talent grid, aggregated themes — is post-diagnostic coaching/org data and stays visible.

**How to enforce it (the right way now):**

In `api/sponsor-data.js`, when assembling each member's report:
```
if (engagement.confidentiality_mode === 'private') {
  // DO NOT include these in the response at all:
  //   - selfVsRaters (the diagnostic 360 detail)
  //   - any flag computed from diagnostic_raters / diagnostic_responses
  delete memberReport.selfVsRaters;
  delete memberReport.diagnosticDerivedFlags;
}
// everything else stays
```
The decision is made **server-side, per engagement, before the payload leaves the function.** The browser literally never receives the confidential numbers for a private engagement, so there is nothing to "unhide" in dev tools.

**Do NOT** rely on RLS to scope this. The endpoint runs as the service role and bypasses RLS, so an RLS policy on `diagnostic_responses` would not stop the endpoint from reading it — the endpoint is trusted to *choose not to send it*. That choice is the control. (Keep `diagnostic_responses` deny-all to anon as the backstop, which it already is post-v26.)

**Defense-in-depth option** (recommended if you want belt-and-suspenders): give the sponsor endpoint a *separate, narrower* code path that simply never SELECTs `diagnostic_responses`/`diagnostic_raters` columns for private engagements — so the confidential data isn't even fetched into the function's memory, not just stripped before send. Cleaner and easier to audit.

**Succession/bench in private mode (open decision #3):** the brief leaves per-leader readiness "always shown." Recommendation: make it a **per-engagement flag** (`show_succession_to_sponsor`, default true), so the strictest confidential deals can turn it off without a code change. Cheap now, painful to retrofit.

---

## 4. The hard feedback gate — enforce in the endpoint, absolutely

Rule: a sponsor sees **no team data** until they've submitted every feedback they owe — but only for members where **the sponsor is the supervisor stakeholder**.

**Build it in `sponsor-data.js`, first thing, before assembling any team payload:**
1. Find the members on this team where this sponsor is the supervisor stakeholder (the supervisor stakeholder row ties sponsor→member; see Section 5).
2. For each, check the existing diagnostic/stakeholder survey: is there an outstanding feedback at the current checkpoint (baseline/d30/d90)?
3. If any are outstanding → return `{ gated: true, owed: [...] }` and **no team data**. The page shows the gate screen with "Provide feedback" deep-links.
4. Only when zero are owed → assemble and return the real payload.

The "Provide feedback" link must **deep-link into the existing diagnostic survey** (`diagnostic-survey.html?token=<supervisor's stakeholder/rater token>`) — see Section 6. Do not build a new survey.

The sandbox's preview-bypass must **not** exist in production. Keep the gate server-side and absolute (matches Alex's lean on open decision #2 — keep it absolute).

---

## 5. Schema additions (all deny-all to anon, like everything post-v26)

New tables. Enable RLS on each with **no anon policy** (consistent with the locked-down posture; only the service role reaches them through the endpoints):

- **`teams`** — `id, name, client_org_name, team_type, primary_sponsor_id, active`, plus the coach-editable narrative JSON (`quick_read, summary, themes, start_stop_continue, intent_impact, snapshot`). Narrative is AI-drafted in production, coach-editable, sponsor read-only.
- **`team_members`** — joins existing **`clients`** (the Member base record) to a team: `team_id, client_id, role, is_coaching_client, coach_summary`. *Reuse `clients` as the Member record — do not create a parallel person table.* "Member = base; Diagnostic + Coaching = stackable engagements" maps to: `clients` row + optional `diagnostics` row + coaching fields already on `clients`.
- **`sponsors`** + **`sponsor_teams`** — Section 2.
- **`recommendations`** — `id, team_id, short_title, description, rationale, category, status, visible_to_client, owner, timeframe, updated_at`.
- **`external_signals`** — `id, team_id, by_name, by_role, channel, level, date_observed, summary, tags, visible_to_client`.

`visible_to_client` on recommendations/signals is itself a server-side gate: the sponsor endpoint only returns rows where `visible_to_client = true`.

**Reuse, don't rebuild:** TP3 scores + self-vs-raters come from the existing `diagnostics` / `diagnostic_raters` / `diagnostic_responses` / `diagnostic_report_drafts`. The 90-day stakeholder scoreboard + check-ins come from the existing `stakeholders` / `survey_tokens` / `survey_responses` / `checkins`. The Decision Room **aggregates** these in the endpoint; it does not duplicate them.

---

## 6. Tie to the existing survey — do not build a new instrument

The 90-day/diagnostic feedback survey already exists (`diagnostic-survey.html` + the diagnostic question bank, at baseline/d30/d90). The sponsor's "Provide feedback" action must:
- Find the **stakeholder/rater row** where this sponsor is the supervisor for that member.
- Deep-link to the existing survey with **that row's existing token**.
- The gate (Section 4) reads completion from the same `survey_responses` / `diagnostic_raters.completed_at` the rest of the portal already uses.

Section 6 of the brief is right: the only new "survey" concept is the optional future Leadership Pulse — out of scope for v1.

---

## 7. Coach side (Alex sees everything)

The coach already has a session that bypasses confidentiality. Manage teams / recommendations / signals / narrative through **`coach.html` + `api/coach-data.js`**:
- Add `teams`, `recommendations`, `external_signals`, `sponsors`, `sponsor_teams`, `team_members` to `coach-data.js`'s table allowlist (read + write) so the coach dashboard can CRUD them through the existing generic proxy.
- The coach Decision Room view = the same data without the confidentiality/gate stripping (coach session ⇒ full visibility).
- The "Add" flow (brief Section 7): one Add dropdown → create-person form (Member base + stackable Diagnostic/Coaching engagement checkboxes) writing to `clients` (+ `diagnostics`); Sponsor as a separate light form writing to `sponsors`/`sponsor_teams`. Attaching an engagement later edits the existing `clients`/`diagnostics` records — **never create a duplicate person.**

---

## 8. Business rules that are display-logic, not security (implement in the endpoint/UI, but they're not the gate)

- **TP3 is point-in-time, never trended** unless a prior *closed* diagnostic cycle exists. The endpoint returns frozen scores from the closed diagnostic; never recompute live. (Open decision #4: age-limit a prior-cycle comparison to ~6–9 months — recommend yes, make it a constant.)
- **Scores freeze at survey close.** Open survey → sponsor gets no numbers (endpoint omits them); coach gets preliminary, flagged. Enforce "sponsor gets no numbers while open" in the endpoint too.
- **Color thresholds** (≥4.0 green / 3.0–3.99 orange / <3.0 red, 1–5 scale) — shared constant, used for bands/chips/grid.
- **Rating scale 1–10 → 1–5** for overall-impact/G1-G2 going forward; existing PDFs stay 1–10. Don't retro-convert old data; branch on cycle.
- **Aggregated-only** for Start/Stop/Continue and Intent-vs-Impact on the sponsor side — the endpoint returns only the team-level aggregate, never per-individual.

---

## 9. Recommended build sequence (mirror how Phase 1 shipped)

Build on a **new branch off the now-secure `main`** (not off `security-hardening-phase1`, which is merged). Same discipline that worked today: small increments, `check.sh` green each time, commit each step, test on a Vercel preview, then a coordinated cutover.

1. **Schema migration** — `teams`, `team_members`, `sponsors`, `sponsor_teams`, `recommendations`, `external_signals`. RLS enabled, **no anon policies**. (One migration file, like `v27_decision_room.sql`.)
2. **`api/sponsor-data.js`** — token validation → feedback gate → confidentiality stripping → assembled payload. This is where the security lives; build and review it first, in isolation, with the prototype's mock shapes as the response contract.
3. **`decision-room.html`** — render the endpoint payload; read-only; the sandbox prototype is your visual/contract reference. Add a `/decision-room` rewrite in `vercel.json`.
4. **Coach management** — extend `coach-data.js` allowlist + the `coach.html` Decision Room/admin views and the Add flow.
5. **Sponsor provisioning + email** — the Sponsor form + a Resend email with the `?token=` link (reuse the email pattern in `get-client.js`).
6. **Cutover** — set any new env vars, deploy preview, smoke-test, merge, and (only if you add new tables that need it) re-run the advisor. Follow `GPS_Portal_CUTOVER_RUNBOOK.md`.

---

## 10. Hard "do NOT" list (the failure modes)

- **Do NOT** use the anon key or `db.from(...)` in any Decision Room page. That pattern is gone; it would bypass the new model and re-open the hole.
- **Do NOT** enforce confidentiality or the feedback gate in page JS. The browser is untrusted. The endpoint is the gate.
- **Do NOT** treat RLS as the per-sponsor access control — the service role bypasses it. RLS is the deny-all backstop only.
- **Do NOT** send confidential self-vs-raters data to the browser "hidden." Omit it from the response server-side (ideally never SELECT it) for private engagements.
- **Do NOT** build a new feedback survey — deep-link the existing one via the supervisor stakeholder token.
- **Do NOT** create duplicate person records — Member is the `clients` base row; engagements stack onto it.
- **Do NOT** ship the sandbox preview-bypass of the feedback gate.

---

## 11. Answers to the brief's open decisions (architecture/security lens)

1. **"Supervisor is sponsor" determination:** set **per engagement at provisioning** (the Sponsor form's "who they supervise" field writes the supervisor stakeholder link). Don't try to auto-derive from org structure you don't have.
2. **Hard gate absolute vs soft:** keep **absolute** (your lean). Simpler to reason about and to defend to participants.
3. **Per-leader succession in strict-confidential:** make it a **per-engagement flag**, default shown. (Section 3.)
4. **Age-limit prior-cycle TP3 trend:** yes, ~6–9 months, as a constant.
5. **Disclosure language:** keep the up-front "the sponsor sees an overall status" notice — it's what keeps "confidential" honest when someone is exited. Put it in the diagnostic intake/consent copy.
6. **Optional next builds (G1/G2 headline, per-leader S/S/C, Pulse survey):** defer past v1; none change the security model.

---

## 12. One-paragraph summary to paste at the top of the build thread

> The portal was hardened on June 3: browsers no longer use the Supabase anon key; all data flows through token/session-validated serverless endpoints that use the service-role key and scope every query in code, and all tables are RLS deny-all to anon as a backstop. Build the Decision Room the same way: a `sponsors` table + `sponsor_token`, a read-only `decision-room.html`, and an `api/sponsor-data.js` endpoint that is the single security boundary — it validates the token, enforces the hard feedback gate, and enforces Private-mode confidentiality by **omitting the individual self-vs-raters data from the response** (not hiding it in the UI, not relying on RLS, which the service role bypasses). Reuse `clients`/`diagnostics`/stakeholder data; add `teams`/`recommendations`/`external_signals`/`sponsors`; tie feedback to the existing diagnostic survey via the supervisor stakeholder token. Model the endpoint on the existing `api/diag-portal.js`.
