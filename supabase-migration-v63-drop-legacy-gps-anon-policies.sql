-- v63 — Revoke permissive anon access on legacy gps_* tables.
--
-- Context: gps_settings / gps_notes / gps_coach_uploads each had anon SELECT/INSERT/UPDATE
-- policies with USING (true) / WITH CHECK (true). Anyone with the public publishable key
-- and the table name could read or overwrite them — including plaintext console passwords,
-- a password hash, and financial data in gps_settings.
--
-- The three internal consoles (gps-executive-console[.|-deploy].html, gps-ea-console.html)
-- now reach these tables ONLY through the authenticated api/console-data.js endpoint
-- (service key, server-side password validation, secret keys blocked). The agent sync
-- skills use the Supabase service role (MCP), not the anon key. So nothing legitimate
-- depends on these anon policies anymore.
--
-- APPLY ONLY AFTER the console repoint is deployed and verified working.

DROP POLICY IF EXISTS anon_read_settings   ON public.gps_settings;
DROP POLICY IF EXISTS anon_write_settings  ON public.gps_settings;
DROP POLICY IF EXISTS anon_update_settings ON public.gps_settings;

DROP POLICY IF EXISTS anon_read_notes      ON public.gps_notes;
DROP POLICY IF EXISTS anon_write_notes     ON public.gps_notes;
DROP POLICY IF EXISTS anon_update_notes    ON public.gps_notes;

DROP POLICY IF EXISTS anon_read_coach      ON public.gps_coach_uploads;
DROP POLICY IF EXISTS anon_write_coach     ON public.gps_coach_uploads;
DROP POLICY IF EXISTS anon_update_coach    ON public.gps_coach_uploads;

-- RLS stays ENABLED on all three (it already is). With no anon policies, anon/public
-- calls are denied; only the service role (server endpoints + MCP) can reach the data.
ALTER TABLE public.gps_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gps_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gps_coach_uploads ENABLE ROW LEVEL SECURITY;

-- ── ROLLBACK (only if a console breaks and must be un-blocked in an emergency) ──
-- NOT recommended — re-opens the public hole. Prefer fixing the endpoint instead.
-- CREATE POLICY anon_read_settings   ON public.gps_settings      FOR SELECT TO anon USING (true);
-- CREATE POLICY anon_write_settings  ON public.gps_settings      FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY anon_update_settings ON public.gps_settings      FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY anon_read_notes      ON public.gps_notes         FOR SELECT TO anon USING (true);
-- CREATE POLICY anon_write_notes     ON public.gps_notes         FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY anon_update_notes    ON public.gps_notes         FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY anon_read_coach      ON public.gps_coach_uploads FOR SELECT TO anon USING (true);
-- CREATE POLICY anon_write_coach     ON public.gps_coach_uploads FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY anon_update_coach    ON public.gps_coach_uploads FOR UPDATE TO anon USING (true) WITH CHECK (true);
