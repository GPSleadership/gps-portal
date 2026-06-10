-- ============================================================================
-- GPS Leadership Portal — Supabase schema snapshot (2026-06-09)
-- Project: pbnkefuqpoztcxfagiod  (org "GPS Leadership Solutions", FREE plan)
-- ============================================================================
-- AUTHORITATIVE DDL = the migration files in the repo: supabase-migration-v2.sql
-- through supabase-migration-v46-*.sql, applied in order. This file is a SNAPSHOT
-- of the live security model (RLS policies + the v44–v46 deltas) for fast recovery
-- and audit. To rebuild the full schema, run the migration files in numeric order
-- against a fresh Postgres/Supabase project, then verify against this snapshot.
--
-- Object counts (public schema, 2026-06-09): ~43 base tables, 1 view
-- (ghl_export_view, now SECURITY INVOKER), plus functions/triggers.
-- ============================================================================

-- ── SECURITY MODEL (the important part) ─────────────────────────────────────
-- Post-v26 lockdown: RLS is ENABLED on every public table. The browser never uses
-- the anon key for data — all reads/writes go through token/session-validated
-- serverless endpoints that use SUPABASE_SECRET_KEY (service role, bypasses RLS).
-- Therefore MOST tables have RLS enabled with NO policies = default-deny to anon.
--
-- The ONLY RLS policies that exist in public (live, 2026-06-09):
--
--   ask_alex_log        service_role_all   ALL     {service_role}   USING(true)
--   gps_coach_uploads   anon_read_coach    SELECT  {anon}           USING(true)   -- legacy
--   gps_coach_uploads   anon_update_coach  UPDATE  {anon}           USING(true)   -- legacy
--   gps_coach_uploads   anon_write_coach   INSERT  {anon}           WITH CHECK(true) -- legacy
--   gps_notes           anon_read_notes    SELECT  {anon}           USING(true)   -- legacy
--   gps_notes           anon_update_notes  UPDATE  {anon}           USING(true)   -- legacy
--   gps_notes           anon_write_notes   INSERT  {anon}           WITH CHECK(true) -- legacy
--   gps_settings        anon_read_settings SELECT  {anon}           USING(true)   -- legacy
--   gps_settings        anon_update_settings UPDATE {anon}          USING(true)   -- legacy
--   gps_settings        anon_write_settings INSERT {anon}           WITH CHECK(true) -- legacy
--
-- The gps_* anon policies are INTENTIONALLY retained: gps-ea-console.html and
-- gps-executive-console*.html read/write those tables directly with the anon key.
-- To retire them, route those consoles through an authed endpoint first.
-- Everything else = deny-all to anon (service-role only). Do NOT add anon policies
-- to "fix" a blocked read — add an endpoint action instead.

-- ── 2026-06-09 schema deltas (v44–v46) ──────────────────────────────────────

-- v44 (F1): close the ghl_export_view leak.
ALTER VIEW public.ghl_export_view SET (security_invoker = true);
REVOKE SELECT ON public.ghl_export_view FROM anon, authenticated;

-- v45: unify the workshop sponsor model.
ALTER TABLE public.clients          ADD COLUMN IF NOT EXISTS is_sponsor boolean NOT NULL DEFAULT false;
ALTER TABLE public.workshop_sponsors ADD COLUMN IF NOT EXISTS sponsor_title text;
-- (+ data backfill: set is_sponsor for existing workshop sponsors; sync
--  workshops.sponsor_client_id from the workshop_sponsors junction where NULL.)

-- v46 (F9): pin search_path on the 4 flagged functions (overload-safe via DO block).
-- See supabase-migration-v46-fix-function-search-path.sql for the exact loop.
-- ALTER FUNCTION public.update_updated_at(...)        SET search_path = public, pg_temp;
-- ALTER FUNCTION public.update_updated_at_column(...) SET search_path = public, pg_temp;
-- ALTER FUNCTION public.get_survey_scoreboard(...)    SET search_path = public, pg_temp;
-- ALTER FUNCTION public.increment_ask_alex(...)       SET search_path = public, pg_temp;

-- ── Storage buckets (live) ──────────────────────────────────────────────────
--   diagnostic-reports   public = true   (F2 OPEN — make private behind signed URLs)
--   org-assets           public = true   (org logos)
-- ============================================================================
