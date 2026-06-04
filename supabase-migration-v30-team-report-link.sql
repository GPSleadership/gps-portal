-- ============================================================================
-- GPS Leadership Portal — Migration v30: TEAM-LINKED, COACH-APPROVED TEAM REPORTS
-- ============================================================================
--
--  The written Team Report (diagnostic_team_reports) used to be generated from
--  an arbitrary hand-picked set of leaders. We are tying it to a Decision Room
--  team: a report belongs to ONE team, is drafted from that team's members who
--  have completed diagnostics, and stays hidden from the sponsor until the coach
--  approves it (same draft -> approve -> show pattern as recommendations).
--
--    • team_id          — the Decision Room team this report was drafted for.
--    • roster_json       — members WITHOUT diagnostic data, kept as roster context.
--    • sponsor_visible   — false until the coach publishes; the sponsor endpoint
--                          only returns the report when this is true.
--    • approved_at       — when the coach published it to the sponsor.
--
--  Additive and safe: existing rows keep their data; team_id/approved_at are NULL
--  and sponsor_visible defaults false (so nothing old is suddenly exposed).
--  RLS posture inherited (diagnostic_team_reports is already deny-all to anon
--  post-v26; all access is through the service-key endpoints).
-- ============================================================================

BEGIN;

ALTER TABLE diagnostic_team_reports
  ADD COLUMN IF NOT EXISTS team_id         UUID REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS roster_json     JSONB,
  ADD COLUMN IF NOT EXISTS sponsor_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dtr_team ON diagnostic_team_reports(team_id);

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   DROP INDEX IF EXISTS idx_dtr_team;
--   ALTER TABLE diagnostic_team_reports
--     DROP COLUMN IF EXISTS team_id,
--     DROP COLUMN IF EXISTS roster_json,
--     DROP COLUMN IF EXISTS sponsor_visible,
--     DROP COLUMN IF EXISTS approved_at;
-- COMMIT;
-- ============================================================================
