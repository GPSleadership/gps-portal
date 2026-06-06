-- ============================================================================
-- GPS Leadership Portal — Migration v38: WORKSHOP SUMMARY APPROVAL GATE
-- ============================================================================
--
--  The AI-authored sponsor narrative (strengths, risks, 90-day focus) and the
--  recommendation must be coach-reviewed/approved before the sponsor sees them
--  (safe-build rule: no un-reviewed AI output goes external). This flag is the
--  gate. The sponsor endpoint withholds the narrative + recommendation until it
--  is TRUE; the factual numbers (participation, NPS, TP3, pre/post theme table,
--  timeline) are always shown.
--
--  Additive + idempotent. Already-applied to production via MCP on 2026-06-05.
-- ============================================================================

BEGIN;

ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS summary_approved BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing DEMO/TEST workshops are pre-approved so their sponsor dashboards
-- keep rendering content during testing.
UPDATE workshops SET summary_approved = TRUE WHERE title LIKE 'DEMO:%' OR title LIKE 'TEST %';

COMMIT;

-- ============================================================================
-- ROLLBACK:
-- BEGIN;
--   ALTER TABLE workshops DROP COLUMN IF EXISTS summary_approved;
-- COMMIT;
-- ============================================================================
