# GPS Portal — Decision Room Cutover (Combined Runbook)

**Status: MERGED TO PRODUCTION on 2026-06-04.** `decision-room-v1` → `main` (`eb6daa4..e243c5c`, fast-forward). Vercel is deploying `main` to `portal.gpsleadership.org`. All four migrations were applied to production Supabase ahead of the merge. What's left is the post-deploy smoke test and test-data cleanup below.

---

## What shipped in this cutover

Decision Room (sponsor-facing team dashboard)
- `decision-room.html` at `/decision-room?token=…` — read-only sponsor view; renders only what the server returns.
- `api/sponsor-data.js` — the security boundary. Validates the sponsor token, enforces the hard feedback gate, and in **private** mode omits the confidential self-vs-raters detail server-side (never just hidden in UI).
- Coach **Decision Room** tab + `+ Add ▾` menu (Member / Team / Sponsor) on both the Clients tab and the Dashboard top-right.

Team-tied Team Reports
- The written AI report is generated **for a Decision Room team** (not arbitrary leaders). Members with completed diagnostics are scored; members without one are listed as **roster** context. A team of one works.
- Drafted unapproved (`sponsor_visible=false`); coach reviews, then **Publish to sponsor** shows it on the sponsor's page. Same draft→approve→show pattern as recommendations.

1–5 scale unification
- 90-day stakeholder survey and the diagnostic Overall-Impact (D1) both collect on **1–5** now. Existing data is scale-tagged, not retro-converted (old reports still read correctly).

Two production bugs fixed (both hit 2026-06-04)
- **Report PDF finalize** no longer uses the dead anon storage write; it routes through `api/diagnostic?action=sign-report-upload` (service-key signed upload URL).
- **Coach session expiry** no longer hangs the dashboard on a spinner; an expired session now returns cleanly to the login screen.

Migrations applied to production (all done): **v27** Decision Room tables · **v28** survey scale · **v29** diagnostic impact_scale · **v30** team-report link (`team_id`, `roster_json`, `sponsor_visible`, `approved_at`).

---

## Post-deploy smoke test (do within a few minutes of the deploy) [You]

On the **real** domain `portal.gpsleadership.org`:

- [ ] `/coach` logs in and the dashboard loads (no spinner hang). The Decision Room tab and the Dashboard `+ Add ▾` menu are present.
- [ ] A client portal `/client?token=…` loads, a check-in submits, Ask Alex answers.
- [ ] Diagnostic finalize: open a diagnostic → Report tab → upload the final PDF → it succeeds (no "row-level security" error) and the client can view it.
- [ ] `+ Add ▾` → **Team** → create a team, add a member who has a completed diagnostic → open the team → **Team Report** → **Generate draft report** → review → **Publish to sponsor**.
- [ ] `+ Add ▾` → **Sponsor** → provision a sponsor on that team → open the `/decision-room?token=…` link (incognito) → team renders, and the published written report shows at the bottom.
- [ ] A diagnostic survey's Overall Impact (Section D) reads **1–5**; a 90-day `/survey?token=…` shows **1–5**.

If any of these fail → **Rollback** below.

---

## Clean up test data [You]

Delete throwaway teams/sponsors/reports created while validating, e.g. in the Supabase SQL editor:

```sql
delete from diagnostic_team_reports where team_id in (select id from teams where name ilike '%test%');
delete from sponsor_teams           where team_id in (select id from teams where name ilike '%test%');
delete from team_members            where team_id in (select id from teams where name ilike '%test%');
delete from sponsors                where name ilike '%test%';
delete from teams                   where name ilike '%test%';
```
(Adjust the `ilike` filters to match what you actually named your test rows.)

---

## Rollback (only if the smoke test fails)

```
git revert -m 1 HEAD
git push origin main
```
Production returns to the pre-Decision-Room code immediately. The migrations (v27–v30) are additive and harmless to the old code, so leave them; no DB rollback needed. Tell me what broke and we fix forward on a branch.

---

## Next feature (after this is confirmed live)

Build the **leader's own results dashboard** into `client.html`'s existing results tab: the leader sees only their own report — no confidentiality stripping, no feedback gate — reusing the Decision Room card components and aggregation, token-scoped through `api/portal-data.js`. Lightest of the three views.
