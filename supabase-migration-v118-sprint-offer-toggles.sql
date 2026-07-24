-- v118 — per-client sprint-offer visibility toggles
--
-- Lets the coach control, per leader, whether the sprint upsell shows at all and
-- whether its PRICE shows — independently. Use case: debriefing a leader who is NOT
-- the buyer (e.g. a sponsor's chief), where the offer is fine to show but the price
-- would confuse ("what's this price?"). Both default OFF (nothing hidden) so existing
-- behavior is unchanged. Server-gated in api/portal-data.js 'renewal-options'.
--
-- NOTE: this migration is IDEMPOTENT and ALREADY APPLIED in production (project
-- pbnkefuqpoztcxfagiod) — both columns exist today with the defaults below, and
-- Michael Gater's row already has hide_sprint_price=true. This file exists so the
-- schema change is documented and versioned like every other migration; running it
-- again is a no-op. (An earlier attempt at this same change was drafted under the
-- filename v109 in a now-retired working folder before the number collided with the
-- committed v109-pricing-config-snapshot migration — v118 is the correct slot, right
-- after v117.)

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS hide_sprint_offer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hide_sprint_price boolean NOT NULL DEFAULT false;

-- ROLLBACK:
-- ALTER TABLE clients
--   DROP COLUMN IF EXISTS hide_sprint_offer,
--   DROP COLUMN IF EXISTS hide_sprint_price;
