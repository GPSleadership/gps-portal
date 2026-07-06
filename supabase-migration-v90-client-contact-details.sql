-- ============================================================================
-- GPS Leadership Portal — Migration v90: CLIENT CONTACT DETAILS
-- ============================================================================
--
--  Fields the client fills in themselves (own profile screen / onboarding) so GPS
--  can send them things and keep basic records: birth date + mailing address.
--
--    date_of_birth       — DATE.
--    mailing_line1/2     — street address.
--    mailing_city/state/postal_code — the rest of the mailing address.
--
--  Client-writable (added to CLIENT_WRITABLE in portal-data.js) — no role or access
--  escalation. Additive and safe. RLS deny-all to anon; writes via token endpoint.
-- ============================================================================

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS date_of_birth        DATE,
  ADD COLUMN IF NOT EXISTS mailing_line1        TEXT,
  ADD COLUMN IF NOT EXISTS mailing_line2        TEXT,
  ADD COLUMN IF NOT EXISTS mailing_city         TEXT,
  ADD COLUMN IF NOT EXISTS mailing_state        TEXT,
  ADD COLUMN IF NOT EXISTS mailing_postal_code  TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.clients
--     DROP COLUMN IF EXISTS mailing_postal_code, DROP COLUMN IF EXISTS mailing_state,
--     DROP COLUMN IF EXISTS mailing_city, DROP COLUMN IF EXISTS mailing_line2,
--     DROP COLUMN IF EXISTS mailing_line1, DROP COLUMN IF EXISTS date_of_birth;
-- COMMIT;
-- ============================================================================
