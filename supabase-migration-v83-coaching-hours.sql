-- ============================================================================
-- GPS Leadership Portal — Migration v83: COACHING HOURS MODEL
-- ============================================================================
--
--  Sponsors buy HOURS, not sessions. The number of sessions is derived from the
--  hours purchased and the session length (30 or 60 min):
--      sessions = round(hours * 60 / session_length_min)
--  e.g. 5 hours of 30-min sessions = 10 sessions; 6 hours of 60-min = 6 sessions.
--
--    coaching_hours_total       — hours the sponsor/client purchased.
--    coaching_session_length_min — 30 or 60. Combined with hours, derives the
--                                  session count stored in coaching_sessions_total.
--
--  coaching_sessions_total / coaching_sessions_completed (v79) stay as the
--  countdown the app already reads — we just now DERIVE the total from hours.
--
--  Additive and safe. Old code ignores the new columns. RLS deny-all to anon.
-- ============================================================================

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS coaching_hours_total        NUMERIC,
  ADD COLUMN IF NOT EXISTS coaching_session_length_min INTEGER;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS coaching_session_length_min;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS coaching_hours_total;
-- COMMIT;
-- ============================================================================
