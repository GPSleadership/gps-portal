-- GPS Portal — Migration v50: Sponsor Hub
-- Additive only. Gives a single sponsor (e.g. Charlene at OMB) one durable link
-- that lists every workshop/assessment they sponsor. Reuses the existing
-- workshop_sponsors linkage (client_id -> workshop_id); adds only a hub token
-- table and an optional curated results-page URL per workshop.
--
-- Security model (post-v26 lockdown): new table has RLS ENABLED with NO anon
-- policies — service-role only, read exclusively through api/sponsor-hub.js.

-- 1) Hub tokens — one per sponsor (client). Revocable.
CREATE TABLE IF NOT EXISTS workshop_sponsor_hubs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  org_name    text,
  hub_token   text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sponsor_hubs_token  ON workshop_sponsor_hubs (hub_token);
CREATE INDEX IF NOT EXISTS idx_sponsor_hubs_client ON workshop_sponsor_hubs (client_id);

ALTER TABLE workshop_sponsor_hubs ENABLE ROW LEVEL SECURITY;
-- No policies = deny-all to anon/authenticated. Service role (used by the API) bypasses RLS.

-- 2) Optional curated results page per workshop (e.g. /omb-speaking-confidently-results.html).
--    When present, the hub links here; otherwise it falls back to the live dashboard.
ALTER TABLE workshops ADD COLUMN IF NOT EXISTS results_page_url text;

-- 3) Backfill the two OMB curated pages (safe no-ops if titles differ; adjust as needed).
UPDATE workshops SET results_page_url = '/omb-message-clarity-results.html'
  WHERE results_page_url IS NULL AND title ILIKE '%Messaging Clarity%';
UPDATE workshops SET results_page_url = '/omb-speaking-confidently-results.html'
  WHERE results_page_url IS NULL AND title ILIKE '%Speaking Confidently%';

-- ============================================================================
-- ROLLBACK
--   ALTER TABLE workshops DROP COLUMN IF EXISTS results_page_url;
--   DROP TABLE IF EXISTS workshop_sponsor_hubs;
-- ============================================================================

-- After applying, mint Charlene's hub token (run once, replace the email):
--   INSERT INTO workshop_sponsor_hubs (client_id, org_name, hub_token)
--   SELECT id, 'Office of Management and Budget',
--          encode(gen_random_bytes(24), 'hex')
--   FROM clients WHERE email = 'charlene.d.mcpherson@omb.eop.gov'
--   RETURNING hub_token;
-- Her link is then:  https://portal.gpsleadership.org/sponsor-hub.html?token=<hub_token>
