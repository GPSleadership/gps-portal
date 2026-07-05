-- ============================================================================
-- GPS Leadership Portal — Migration v85: RECOMMENDATION TRACKING
-- ============================================================================
--
--  The agreed recommendations from the diagnostic/proposal, tracked through the
--  engagement and shown on the sponsor page. Council decision: unify on the team
--  model — so these columns are ADDED to the existing team-based `recommendations`
--  table, letting a rec attach to a single leader (client_id) today and a team
--  (team_id, already present) tomorrow for multi-leader sponsors (JMAA).
--
--    client_id          — the leader this rec belongs to (coaching engagement).
--    responsible_party  — 'sponsor' | 'leader' | 'coach'. Gates completion:
--                         the SPONSOR may complete their own; only the COACH may
--                         complete a leader/coach-owned rec (ground truth).
--    coach_comment      — the coach's note on this rec (shown to the sponsor).
--    completed_at       — when it was marked done.
--    completed_by       — 'coach' | 'sponsor'.
--
--  Additive and safe. RLS deny-all to anon; all access via service-role endpoints.
-- ============================================================================

BEGIN;

ALTER TABLE public.recommendations
  ADD COLUMN IF NOT EXISTS client_id         UUID,
  ADD COLUMN IF NOT EXISTS responsible_party TEXT,
  ADD COLUMN IF NOT EXISTS coach_comment     TEXT,
  ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by      TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.recommendations
--     DROP COLUMN IF EXISTS completed_by, DROP COLUMN IF EXISTS completed_at,
--     DROP COLUMN IF EXISTS coach_comment, DROP COLUMN IF EXISTS responsible_party,
--     DROP COLUMN IF EXISTS client_id;
-- COMMIT;
-- ============================================================================
