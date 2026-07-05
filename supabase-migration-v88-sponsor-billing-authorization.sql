-- ============================================================================
-- GPS Leadership Portal — Migration v88: MULTI-PERSON APPROVAL + BILLING MODE
-- ============================================================================
--
--  Phase 3: a sponsor (e.g. Rose / JMAA) approves several leaders' plans at once
--  and the system records WHAT was authorized, then routes billing the right way
--  for that organization.
--
--  organizations.billing_mode — how this org pays. Coach-set, per organization.
--     'both'     (DEFAULT) — sponsor chooses: pay online now OR request the SOW/invoice.
--     'online'   — commercial client: show the payment link only.
--     'contract' — government / quasi-gov (JMAA): SOW → contract → invoice.
--                  NEVER show a payment link; capture the authorization + PO/contact.
--  organizations.payment_link_url — per-org payment link override (optional).
--  renewal_config.sponsor_payment_link_url — global default payment link.
--
--  sponsor_authorizations — one row per bundled approval event: who approved, which
--  leaders, how many seats, the billing choice, and any PO / contracting note. This
--  is the record that feeds the invoice / SOW so nothing is guessed.
--
--  Additive and safe. RLS deny-all to anon; all access via validated endpoints.
-- ============================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS billing_mode      TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS payment_link_url  TEXT;

ALTER TABLE public.renewal_config
  ADD COLUMN IF NOT EXISTS sponsor_payment_link_url TEXT;

CREATE TABLE IF NOT EXISTS public.sponsor_authorizations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id        UUID REFERENCES public.sponsors(id) ON DELETE SET NULL,
  team_id           UUID,
  leader_client_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  seat_count        INTEGER NOT NULL DEFAULT 0,
  billing_choice    TEXT,                      -- 'online' | 'contract'
  billing_note      TEXT,                      -- PO number / contracting contact
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sponsor_authorizations_sponsor ON public.sponsor_authorizations(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_sponsor_authorizations_team    ON public.sponsor_authorizations(team_id);

ALTER TABLE public.sponsor_authorizations ENABLE ROW LEVEL SECURITY;
-- No policies = deny-all to anon/authenticated; only the service role bypasses RLS.

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   DROP TABLE IF EXISTS public.sponsor_authorizations;
--   ALTER TABLE public.renewal_config DROP COLUMN IF EXISTS sponsor_payment_link_url;
--   ALTER TABLE public.organizations DROP COLUMN IF EXISTS payment_link_url, DROP COLUMN IF EXISTS billing_mode;
-- COMMIT;
-- ============================================================================
