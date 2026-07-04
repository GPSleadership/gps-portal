-- ============================================================================
-- GPS Leadership Portal — Migration v80: VISION + GOAL-CHANGE ANCHORING
-- ============================================================================
--
--  Project #2 (Goal + Vision anchoring for Ask Alex).
--
--    vision_statement        — the leader's one-line vision (leader-editable, but
--                              every save must pass the specificity gate). Seeded
--                              from diagnostics.self_three_year_vision on first use.
--    vision_last_edited_at    — when the leader last saved their vision.
--    vision_flagged_for_review — true when the gate was bypassed after 2 failed
--                              revisions (coach should review); default false.
--    goal_change_requested_at — set when the leader requests a change to their
--                              (read-only) 90-day goal; cleared when the coach acts.
--
--  The 90-day goal itself stays in clients.goal_statement and is editable ONLY by
--  coach/admin (the leader never writes it) — enforced in portal-data's writable
--  allowlist, not here.
--
--  Additive and safe. Old code ignores the new columns. RLS deny-all to anon
--  (post-v26); all access via service-role endpoints.
-- ============================================================================

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vision_statement          TEXT,
  ADD COLUMN IF NOT EXISTS vision_last_edited_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vision_flagged_for_review  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS goal_change_requested_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS goal_change_note           TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients DROP COLUMN IF EXISTS goal_change_requested_at;
--   ALTER TABLE clients DROP COLUMN IF EXISTS vision_flagged_for_review;
--   ALTER TABLE clients DROP COLUMN IF EXISTS vision_last_edited_at;
--   ALTER TABLE clients DROP COLUMN IF EXISTS vision_statement;
-- COMMIT;
-- ============================================================================
