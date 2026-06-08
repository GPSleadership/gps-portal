# GPS Portal Weekly Security Sweep — 2026-06-08

**Result: ⚠️ 2 items need attention (no regressions on sensitive tables)**

Run date: 2026-06-08 | Automated sweep | Read-only

---

## OPS_STATE Read

OPS_STATE.md found and read (last updated 2026-06-08, freshly seeded — EA Thread has not yet written post-sweep content). The more detailed `OPS_STATE_2026-06-08` version was also located and read.

**Calendar flag found:** Blaine Brothers board chair meeting estimated ~2 weeks from June 8 (approx. June 22). This is outside the 7-day window, so standard sweep applies. No elevated sweep triggered. Portal should be clean before that meeting.

---

## Findings

### YELLOW — ERROR-level advisor: `ghl_export_view` is SECURITY DEFINER

- **What:** `public.ghl_export_view` is defined with `SECURITY DEFINER`, meaning it runs as the view creator (full DB access), not as the querying user. Any role that can SELECT from this view bypasses RLS entirely for whatever data the view exposes.
- **Risk:** If this view is accessible to `anon` or `authenticated` roles (which is likely given the pre-v26 policy landscape), external users can read data through it as a superuser. This is an ERROR-level Supabase finding.
- **Status:** Unknown whether this is pre-existing or newly created. Not flagged in the June 2026 premortem notes — treat as new until confirmed otherwise.
- **Action:** Check what roles can SELECT from `ghl_export_view` (`\dp ghl_export_view` in psql or `GRANT` inspection). If `anon` has access, restrict it or rewrite as `SECURITY INVOKER`. Do this before the Blaine Brothers meeting.

---

### YELLOW — Permissive anon policies still active on 3 tables

The following tables have `USING(true)` / `WITH CHECK(true)` anon UPDATE and INSERT policies (Supabase WARN level):

| Table | Policy | Command |
|---|---|---|
| `gps_coach_uploads` | `anon_update_coach` | UPDATE |
| `gps_coach_uploads` | `anon_write_coach` | INSERT |
| `gps_notes` | `anon_update_notes` | UPDATE |
| `gps_notes` | `anon_write_notes` | INSERT |
| `gps_settings` | `anon_update_settings` | UPDATE |
| `gps_settings` | `anon_write_settings` | INSERT |

- **Context:** These are likely intentional for the coach portal's anonymous-access workflow (coach uploads, session notes, settings saved by the coach UI without auth). Not a regression from last week.
- **Action:** Confirm these are intentional. If yes, document the intent in the v26 migration notes so future sweeps don't re-investigate. If not, lock them down as part of Phase 1.

---

### WARN — 4 functions with mutable search_path

`update_updated_at`, `update_updated_at_column`, `get_survey_scoreboard`, `increment_ask_alex` — all lack a fixed `search_path`. Low exploitability but a Supabase security advisory. Carry forward to Phase 1 remediation list.

---

## Checks Passed

| Check | Result |
|---|---|
| Secrets in client.html / coach.html | ✅ No `service_role` found |
| RLS drift — sensitive tables (clients, diagnostics, diagnostic_responses, diagnostic_raters, ask_alex_log, coach_settings, admin_accounts) | ✅ **0 anon policies with USING(true) — v26 lockdown holding** |
| Backup recency | ✅ GPS_Leadership_Backup_2026-06-08.zip exists (created today) |
| OPS_STATE read | ✅ Found, dated 2026-06-08, no demo within 7 days |

---

## Advisor Summary

| Level | Count | Notes |
|---|---|---|
| ERROR | 1 | `ghl_export_view` SECURITY DEFINER |
| WARN | 10 | 6 permissive anon policies (3 tables) + 4 mutable search_path functions |
| INFO | 32 | RLS enabled / no policies — expected post-v26 state (default deny) |

---

## RLS Drift Tracking

**Sensitive-table anon `USING(true)` policy count: 0**
*(Week-over-week baseline — target is 0 and holding)*

---

## Repo Health Note

The Tool Creation folder is not a git repository (or git is not accessible from this environment). Cannot confirm current branch or check for uncommitted `.html`/`.js`/`.sql` files. Recommend Alex confirm the `security-hardening-phase1` branch status directly in the repo before the Blaine Brothers meeting.

---

*Automated sweep — no changes made to the database or codebase.*
