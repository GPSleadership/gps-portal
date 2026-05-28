-- ============================================================
-- GPS Leadership Portal — Migration v17
-- Adds:
--   1. diagnostics.is_archived           — archive / hide from default view
--   2. diagnostics.all_raters_complete_at — one-time stamp when 100% respond
--                                           (used to throttle coach alert)
-- Run in: Supabase → SQL Editor
-- ============================================================

-- 1. Archive flag
ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. All-raters-complete timestamp
ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS all_raters_complete_at TIMESTAMPTZ;

COMMENT ON COLUMN diagnostics.is_archived IS
  'When true, diagnostic is hidden from the default All/Active/Setup/Done views. Only visible in the Archived filter. Soft delete — data is preserved.';

COMMENT ON COLUMN diagnostics.all_raters_complete_at IS
  'Set once when all non-self raters have completed their surveys (100% response rate). Used to send a one-time coach notification and prevent duplicate alerts.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_diagnostics_archived
  ON diagnostics (is_archived)
  WHERE is_archived = TRUE;

CREATE INDEX IF NOT EXISTS idx_diagnostics_all_complete
  ON diagnostics (all_raters_complete_at)
  WHERE all_raters_complete_at IS NULL;
