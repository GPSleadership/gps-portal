-- ============================================================================
-- GPS Leadership Portal — Migration v34: RICHER RECOMMENDATION FIELDS
-- ============================================================================
--
--  The AI recommendation generator now tags each recommendation with its target
--  band, GPS delivery fit, quick-start activation steps, and a traceability tag.
--
--    target_band        — which tier it's for: top | middle | bottom | system
--                         (may be combined, e.g. "top,middle").
--    gps_support_type   — core_service | co_led | client_owned | outside_scope.
--                         COACH-ONLY (drives the internal "GPS fit" note).
--    quick_start_today  — one tiny action the leader can take by end of today.
--    quick_start_week   — one concrete step by end of this week.
--    source_section     — what Decision Room content this was derived from
--                         (e.g. "team_summary,themes"). COACH-ONLY traceability.
--
--  Additive and safe. RLS posture inherited (recommendations is deny-all to anon).
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS target_band       TEXT,
  ADD COLUMN IF NOT EXISTS gps_support_type  TEXT,
  ADD COLUMN IF NOT EXISTS quick_start_today TEXT,
  ADD COLUMN IF NOT EXISTS quick_start_week  TEXT,
  ADD COLUMN IF NOT EXISTS source_section    TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE recommendations
--     DROP COLUMN IF EXISTS target_band,
--     DROP COLUMN IF EXISTS gps_support_type,
--     DROP COLUMN IF EXISTS quick_start_today,
--     DROP COLUMN IF EXISTS quick_start_week,
--     DROP COLUMN IF EXISTS source_section;
-- COMMIT;
-- ============================================================================
