-- ============================================================================
-- GPS Leadership Portal — Migration v87: recommendations.team_id NULLABLE
-- ============================================================================
--
--  Recommendations can now be CLIENT-scoped (a coaching leader, via client_id —
--  v85) as well as TEAM-scoped (Decision Room, via team_id). A client-scoped rec
--  has no team, so team_id must be allowed to be null. The Decision Room code
--  always sets team_id, so its rows are unaffected.
--
--  Additive and safe: only relaxes a NOT NULL constraint; no data changes.
-- ============================================================================

BEGIN;

ALTER TABLE public.recommendations ALTER COLUMN team_id DROP NOT NULL;

COMMIT;

-- ============================================================================
-- ROLLBACK (only if no client-scoped recs exist, else this will fail):
-- BEGIN;
--   ALTER TABLE public.recommendations ALTER COLUMN team_id SET NOT NULL;
-- COMMIT;
-- ============================================================================
