-- ============================================================================
-- GPS Leadership Portal — Migration v82: CHECK-IN-DRIVEN SESSION COUNT
-- ============================================================================
--
--  Lets the leader's weekly check-in auto-advance the coaching session countdown
--  (coaching_sessions_completed) so the coach never has to manually "Log a session."
--
--    counted_toward_sessions — set true on the checkin row that already advanced
--                              the count for its week. Makes the auto-increment
--                              IDEMPOTENT per week: re-submitting or editing a
--                              week's check-in never double-counts, and it
--                              coexists with the manual "Log a session" button.
--
--  Additive and safe. Old code ignores the column. RLS deny-all to anon (post-v26);
--  all writes go through the token/service-role portal-data endpoint.
-- ============================================================================

BEGIN;

ALTER TABLE public.checkins
  ADD COLUMN IF NOT EXISTS counted_toward_sessions BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.checkins DROP COLUMN IF EXISTS counted_toward_sessions;
-- COMMIT;
-- ============================================================================
