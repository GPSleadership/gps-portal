-- ============================================================================
-- GPS Leadership Portal — Migration v89: AUTHORIZATION PAID TRACKING
-- ============================================================================
--
--  The coach's manual "paid" ledger. The system records what a sponsor AUTHORIZED
--  (sponsor_authorizations, v88); this adds the coach's confirmation that the money
--  actually landed. There is no payment processing here — the coach flips this after
--  verifying payment in FastPayDirect / the bank / the invoice.
--
--    paid_at — when the coach marked it paid (null = not yet paid).
--    paid_by — which coach marked it (audit).
--
--  Additive and safe. RLS deny-all to anon; written only via the coach endpoint.
-- ============================================================================

BEGIN;

ALTER TABLE public.sponsor_authorizations
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.sponsor_authorizations DROP COLUMN IF EXISTS paid_by, DROP COLUMN IF EXISTS paid_at;
-- COMMIT;
-- ============================================================================
