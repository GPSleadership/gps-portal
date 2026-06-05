-- ============================================================================
-- GPS Leadership Portal — Migration v33: COACHING CADENCE
-- ============================================================================
--
--  Attendance was scored as attended ÷ every week, which penalizes leaders who
--  meet with their coach every other week (their off-weeks counted as misses).
--  This adds a per-client coaching cadence so the engagement denominator is the
--  number of sessions EXPECTED over the elapsed weeks, not the calendar weeks.
--
--    coaching_cadence — 'weekly' | 'biweekly' | 'monthly' (default 'weekly').
--
--  Additive and safe. RLS posture inherited (clients is deny-all to anon post-v26).
-- ============================================================================

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS coaching_cadence TEXT DEFAULT 'weekly';

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients DROP COLUMN IF EXISTS coaching_cadence;
-- COMMIT;
-- ============================================================================
