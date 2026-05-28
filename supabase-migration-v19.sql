-- GPS Portal Migration v19
-- Interview feature: per-diagnostic interview slots with calendar link and cap
-- Run in Supabase SQL Editor

-- 1. Add interview fields to diagnostics
ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS interviews_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS interview_calendar_link TEXT,
  ADD COLUMN IF NOT EXISTS interview_max_count     INTEGER;

-- 2. Add interview flag to raters
ALTER TABLE diagnostic_raters
  ADD COLUMN IF NOT EXISTS will_interview BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Index for quick rater query (count interviews assigned per diagnostic)
CREATE INDEX IF NOT EXISTS idx_raters_will_interview
  ON diagnostic_raters (diagnostic_id, will_interview)
  WHERE will_interview = TRUE;

-- Verify
SELECT 'Migration v19 complete — interview columns added' AS status;
