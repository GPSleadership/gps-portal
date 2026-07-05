-- ============================================================================
-- GPS Leadership Portal — Migration v86: SPONSOR → LEADERS (many-to-many)
-- ============================================================================
--
--  Lets ONE sponsor follow MULTIPLE coaching leaders (e.g. JMAA / Rose sponsors
--  several people). Single-leader sponsors keep working exactly as before via
--  sponsors.linked_client_id — this table is additive and only used when a
--  sponsor has more than one leader.
--
--    sponsor_leaders(sponsor_id, client_id) — one row per (sponsor, leader) the
--    sponsor is authorized to follow. The sponsor's full authorized set is
--    linked_client_id (legacy single) UNION these rows.
--
--  RLS deny-all to anon; the /sponsor endpoint reads it with the service role
--  after validating the sponsor token, and re-checks membership before returning
--  any leader's data or accepting a rec completion.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.sponsor_leaders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id  UUID NOT NULL REFERENCES public.sponsors(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES public.clients(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sponsor_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_sponsor_leaders_sponsor ON public.sponsor_leaders(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_sponsor_leaders_client  ON public.sponsor_leaders(client_id);

ALTER TABLE public.sponsor_leaders ENABLE ROW LEVEL SECURITY;
-- No policies = deny-all to anon/authenticated; only the service role bypasses RLS.

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   DROP TABLE IF EXISTS public.sponsor_leaders;
-- COMMIT;
-- ============================================================================
