-- ============================================================================
-- GPS Leadership Portal — Migration v29: DIAGNOSTIC OVERALL-IMPACT SCALE
-- ============================================================================
--
--  The diagnostic's Overall Impact question (D1) historically used a 1-10 scale,
--  while every other TP3 item is 1-5. The product is unifying all ratings on
--  1-5. As with the 90-day survey (v28), we do NOT retro-convert existing data;
--  we TAG each diagnostic with the scale its D1 was collected on so the report
--  formatter labels it correctly.
--
--    • Existing diagnostics → impact_scale 10 (what they were collected on).
--    • New diagnostics default to 5 (D1 now collected 1-5 in diagnostic-survey).
--    • api/diagnostic.js report formatting reads diag.impact_scale and labels
--      the denominator accordingly; old and new reports are both correct.
--
--  RLS posture inherited (diagnostics is already deny-all to anon post-v26).
-- ============================================================================

BEGIN;

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS impact_scale SMALLINT NOT NULL DEFAULT 5;

-- Tag every existing diagnostic with the scale its D1 was collected on (1-10).
UPDATE diagnostics SET impact_scale = 10 WHERE created_at < now();

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE diagnostics DROP COLUMN IF EXISTS impact_scale;
-- COMMIT;
-- ============================================================================
