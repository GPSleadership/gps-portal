-- ============================================================================
-- GPS Leadership Portal — Migration v28: SURVEY SCALE MARKER (branch on cycle)
-- ============================================================================
--
--  The 90-day stakeholder scoreboard (survey_responses) historically collected
--  a 1-10 score. The product is moving every rating to a 1-5 scale to match TP3
--  and the Decision Room color system. Rather than retro-convert existing data
--  (which would corrupt prior cycles), we TAG each response with the scale it
--  was collected on and normalize per-row at read time.
--
--    • Existing rows  → scale 10 (what they were collected on).
--    • New rows default to 10 for now; once the survey UI is switched to 1-5,
--      the insert path (api/survey.js) writes scale = 5 explicitly.
--    • The sponsor-data endpoint normalizes every row to 1-5 by its own scale,
--      so old and new data are both read correctly.
--
--  The CHECK stays 1-10 so both scales remain valid during the transition;
--  a 1-5 score is a subset of 1-10, so no constraint change is needed.
--  RLS posture is inherited (survey_responses is already deny-all to anon).
-- ============================================================================

BEGIN;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS scale SMALLINT NOT NULL DEFAULT 10;

-- Tag every existing row with the scale it was actually collected on.
UPDATE survey_responses SET scale = 10 WHERE scale IS NULL;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE survey_responses DROP COLUMN IF EXISTS scale;
-- COMMIT;
-- ============================================================================
