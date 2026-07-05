-- ============================================================================
-- GPS Leadership Portal — Migration v84: MOMENTUM VIEW DEFAULT ON
-- ============================================================================
--
--  The leader's "momentum view" (phase + encouragement, NEVER a raw session count
--  or renewal prompt) is safe to show broadly, so it now defaults ON. Coaches can
--  still turn it OFF per client (e.g. some sponsor-paid engagements).
--
--  Flips the column default to true and turns it on for existing clients that were
--  only OFF because false was the old default.
-- ============================================================================

BEGIN;

ALTER TABLE public.clients ALTER COLUMN show_sessions_to_leader SET DEFAULT true;

UPDATE public.clients
   SET show_sessions_to_leader = true
 WHERE show_sessions_to_leader IS DISTINCT FROM true;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.clients ALTER COLUMN show_sessions_to_leader SET DEFAULT false;
--   -- (no automatic un-backfill: per-client values are now intentional)
-- COMMIT;
-- ============================================================================
