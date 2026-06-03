-- ============================================================================
-- GPS Leadership Portal — Migration v26: RLS LOCKDOWN
-- ============================================================================
--
--  ⚠️  DO NOT APPLY THIS UNTIL THE APP IS REWIRED.  ⚠️
--
--  This migration drops every permissive `anon`/`public` policy that currently
--  lets the public anon key read and write the database directly. After it runs,
--  ONLY the service_role key (used by the api/*.js serverless functions) can
--  touch these tables. RLS stays ENABLED on every table; there are simply no
--  anon policies left, so the anon role is denied by default.
--
--  Prerequisite (see PHASE1_PLAN.md): every browser page that currently calls
--  Supabase with the anon key must first be rewired to go through a service-key
--  serverless endpoint, AND diagnostic.js + send-reminders.js must be switched
--  from SUPABASE_ANON to SUPABASE_SECRET_KEY. Applying this before that work is
--  done WILL take the live portal down.
--
--  Apply during the cutover window (Step 8). A ROLLBACK block is at the bottom.
-- ============================================================================

BEGIN;

-- ── clients (CEO PII, goals, tokens) ────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_clients" ON clients;

-- ── coach_settings (held the plaintext password) ────────────────────────────
DROP POLICY IF EXISTS "anon_all_coach_settings" ON coach_settings;

-- ── admin_accounts ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Service can manage admin_accounts" ON admin_accounts;
DROP POLICY IF EXISTS "Service can read admin_accounts"   ON admin_accounts;

-- ── check-ins + drafts ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_checkins"        ON checkins;
DROP POLICY IF EXISTS "Anyone can delete drafts" ON checkin_drafts;
DROP POLICY IF EXISTS "Anyone can read drafts"   ON checkin_drafts;
DROP POLICY IF EXISTS "Anyone can update drafts" ON checkin_drafts;
DROP POLICY IF EXISTS "Anyone can upsert drafts" ON checkin_drafts;

-- ── sprints + closeouts ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anon all sprints"            ON sprints;
DROP POLICY IF EXISTS "Allow anon read sprints"           ON sprints;
DROP POLICY IF EXISTS "Allow anon insert sprint_closeouts" ON sprint_closeouts;
DROP POLICY IF EXISTS "Allow anon read sprint_closeouts"   ON sprint_closeouts;

-- ── diagnostics core ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anon insert diagnostics"          ON diagnostics;
DROP POLICY IF EXISTS "Allow anon read diagnostics"            ON diagnostics;
DROP POLICY IF EXISTS "Allow anon update diagnostics"          ON diagnostics;
DROP POLICY IF EXISTS "anon_select_diagnostics_by_client"      ON diagnostics;
DROP POLICY IF EXISTS "anon_update_diagnostics_rater_finalize" ON diagnostics;

-- ── diagnostic raters ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anon insert diagnostic_raters" ON diagnostic_raters;
DROP POLICY IF EXISTS "Allow anon read diagnostic_raters"   ON diagnostic_raters;
DROP POLICY IF EXISTS "Allow anon update diagnostic_raters" ON diagnostic_raters;
DROP POLICY IF EXISTS "anon_insert_diagnostic_raters"       ON diagnostic_raters;
DROP POLICY IF EXISTS "anon_select_diagnostic_raters"       ON diagnostic_raters;

-- ── diagnostic responses (confidential 360 feedback — 351 rows) ─────────────
DROP POLICY IF EXISTS "Allow anon insert diagnostic_responses" ON diagnostic_responses;
DROP POLICY IF EXISTS "Allow anon read diagnostic_responses"   ON diagnostic_responses;

-- ── diagnostic report drafts ────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anon insert diagnostic_report_drafts" ON diagnostic_report_drafts;
DROP POLICY IF EXISTS "Allow anon read diagnostic_report_drafts"   ON diagnostic_report_drafts;
DROP POLICY IF EXISTS "Allow anon update diagnostic_report_drafts" ON diagnostic_report_drafts;
DROP POLICY IF EXISTS "anon_select_diagnostic_report_drafts"       ON diagnostic_report_drafts;

-- ── diagnostic team reports + question overrides ────────────────────────────
DROP POLICY IF EXISTS "Allow anon insert" ON diagnostic_team_reports;
DROP POLICY IF EXISTS "Allow anon read"   ON diagnostic_team_reports;
DROP POLICY IF EXISTS "Allow anon insert diagnostic_question_overrides" ON diagnostic_question_overrides;
DROP POLICY IF EXISTS "Allow anon read diagnostic_question_overrides"   ON diagnostic_question_overrides;
DROP POLICY IF EXISTS "Allow anon update diagnostic_question_overrides" ON diagnostic_question_overrides;

-- ── ask alex (private client questions) ─────────────────────────────────────
DROP POLICY IF EXISTS "anon_select"             ON ask_alex_log;     -- keep service_role_all
DROP POLICY IF EXISTS "anon_all_ask_alex_usage" ON ask_alex_usage;

-- ── stakeholder survey system ───────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_all_stakeholders"      ON stakeholders;
DROP POLICY IF EXISTS "anon_all_survey_responses"  ON survey_responses;
DROP POLICY IF EXISTS "anon_all_survey_tokens"     ON survey_tokens;
DROP POLICY IF EXISTS "Allow anon insert self_checks" ON self_checks;
DROP POLICY IF EXISTS "Allow anon read self_checks"   ON self_checks;

-- ── email log + templates ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "Service can insert email_log" ON email_log;
DROP POLICY IF EXISTS "Service can select email_log" ON email_log;
DROP POLICY IF EXISTS "Allow anon read email_templates" ON email_templates;

-- ── undocumented tables found during live verification ──────────────────────
DROP POLICY IF EXISTS "allow_all_coach_uploads" ON gps_coach_uploads;
DROP POLICY IF EXISTS "allow_all_settings"      ON gps_settings;
DROP POLICY IF EXISTS "allow_delete" ON gps_notes;
DROP POLICY IF EXISTS "allow_insert" ON gps_notes;
DROP POLICY IF EXISTS "allow_read"   ON gps_notes;
DROP POLICY IF EXISTS "allow_update" ON gps_notes;

-- ── SECURITY DEFINER functions: server-side only, revoke public execute ─────
REVOKE EXECUTE ON FUNCTION public.get_survey_scoreboard(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_ask_alex(uuid, timestamptz) FROM anon, authenticated;

-- NOTE: ghl_export_view (SECURITY DEFINER) should be recreated as SECURITY
-- INVOKER in a follow-up once its consumers are confirmed. Left in place here
-- to avoid breaking any current export flow during cutover.

COMMIT;

-- ============================================================================
-- ROLLBACK (only if cutover must be reversed; recreates prior permissive state)
-- Keep until the rewired app has run clean for ~1 week, then delete.
-- ============================================================================
-- BEGIN;
--   CREATE POLICY "anon_all_clients"        ON clients        FOR ALL TO anon USING (true) WITH CHECK (true);
--   CREATE POLICY "anon_all_coach_settings" ON coach_settings FOR ALL TO anon USING (true) WITH CHECK (true);
--   CREATE POLICY "anon_all_checkins"       ON checkins       FOR ALL TO anon USING (true) WITH CHECK (true);
--   CREATE POLICY "Allow anon read diagnostics"   ON diagnostics FOR SELECT USING (true);
--   CREATE POLICY "Allow anon insert diagnostics" ON diagnostics FOR INSERT WITH CHECK (true);
--   CREATE POLICY "Allow anon update diagnostics" ON diagnostics FOR UPDATE USING (true);
--   CREATE POLICY "Allow anon read diagnostic_raters"   ON diagnostic_raters FOR SELECT USING (true);
--   CREATE POLICY "Allow anon insert diagnostic_raters" ON diagnostic_raters FOR INSERT WITH CHECK (true);
--   CREATE POLICY "Allow anon update diagnostic_raters" ON diagnostic_raters FOR UPDATE USING (true);
--   CREATE POLICY "Allow anon read diagnostic_responses"   ON diagnostic_responses FOR SELECT USING (true);
--   CREATE POLICY "Allow anon insert diagnostic_responses" ON diagnostic_responses FOR INSERT WITH CHECK (true);
--   -- (recreate remaining policies from supabase-migration-v13.sql / v18 / v3 as needed)
--   GRANT EXECUTE ON FUNCTION public.get_survey_scoreboard(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.increment_ask_alex(uuid, timestamptz) TO anon, authenticated;
-- COMMIT;
