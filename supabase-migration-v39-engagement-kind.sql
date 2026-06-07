-- ============================================================================
-- GPS Leadership Portal — Migration v39: ENGAGEMENT KIND (workshop | assessment)
-- ============================================================================
--
--  Lets the workshop module run standalone TP3 Organizational Assessments —
--  the same engine (roster, shared/QR survey, reminders, theme scoring, AI
--  summary with coach approval gate, sponsor dashboard, exports, recap, NPS
--  flywheel) with the workshop-specific parts removed: one survey wave (the
--  existing "pre" slot), no workshop date, no post survey, assessment-flavored
--  lifecycle and labels.
--
--  Additive + idempotent. Default 'workshop' so every existing row is untouched.
-- ============================================================================

BEGIN;

ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS engagement_kind TEXT NOT NULL DEFAULT 'workshop'
  CHECK (engagement_kind IN ('workshop','assessment'));

COMMENT ON COLUMN workshops.engagement_kind IS
  'workshop = pre/post survey around a delivered workshop. assessment = standalone TP3 Organizational Assessment: one survey wave (stored in the pre slot), no workshop event, no post survey.';

COMMIT;

-- ============================================================================
-- ROLLBACK:
-- BEGIN;
--   ALTER TABLE workshops DROP COLUMN IF EXISTS engagement_kind;
-- COMMIT;
-- ============================================================================
