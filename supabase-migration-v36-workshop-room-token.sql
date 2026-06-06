-- ============================================================================
-- GPS Leadership Portal — Migration v36: WORKSHOP IN-ROOM (QR) SURVEY TOKEN
-- ============================================================================
--
--  Alex runs the post-workshop survey LIVE, ~20-30 min before the session ends,
--  by putting a QR code on a PowerPoint slide that the whole room scans. That
--  needs ONE shared link per workshop (not a per-participant token). This adds a
--  single `room_survey_token` to each workshop. The same link works for an
--  in-room PRE survey too (phase is chosen in the URL).
--
--  Additive + idempotent. Existing rows get a distinct token via the volatile
--  default (table rewrite evaluates it per row). RLS unchanged (deny-all to anon;
--  the room survey reads/writes only through api/workshop-survey.js service-key).
-- ============================================================================

BEGIN;

ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS room_survey_token TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT;

CREATE INDEX IF NOT EXISTS idx_workshops_room_token ON workshops (room_survey_token);

COMMENT ON COLUMN workshops.room_survey_token IS
  'Single shared survey link for in-room completion (QR on a slide). One link for the whole room; responses are stored at the workshop level, optionally matched to a participant by email.';

COMMIT;

-- ============================================================================
-- ROLLBACK:
-- BEGIN;
--   ALTER TABLE workshops DROP COLUMN IF EXISTS room_survey_token;
-- COMMIT;
-- ============================================================================
