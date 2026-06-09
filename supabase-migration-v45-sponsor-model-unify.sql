-- Migration v45: unify the workshop sponsor model
-- Applied: 2026-06-09
-- Purpose:
--   1. Add a real role flag (clients.is_sponsor) so sponsors are identifiable by flag, not by absence.
--   2. Add workshop_sponsors.sponsor_title so the sponsor's title lives on the junction,
--      not patched onto a (possibly shared) clients row.
--   3. Backfill the flag for everyone currently attached as a workshop sponsor.
--   4. Sync workshops.sponsor_client_id from the junction where it drifted to NULL
--      (fixes assessments like "JMAA Management Team Pulse Survey" that had junction
--      sponsors but no single-field pointer, so the Overview/sponsor dashboard showed none).
-- Additive + corrective: old code ignores the new columns; setting sponsor_client_id only helps it.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_sponsor boolean NOT NULL DEFAULT false;

ALTER TABLE workshop_sponsors
  ADD COLUMN IF NOT EXISTS sponsor_title text;

-- Flag existing workshop sponsors
UPDATE clients c
SET is_sponsor = true
WHERE EXISTS (SELECT 1 FROM workshop_sponsors ws WHERE ws.client_id = c.id);

-- Repoint single-field sponsor from the junction where it drifted to NULL
UPDATE workshops w
SET sponsor_client_id = (
  SELECT ws.client_id FROM workshop_sponsors ws
  WHERE ws.workshop_id = w.id
  ORDER BY ws.added_at ASC
  LIMIT 1
)
WHERE w.sponsor_client_id IS NULL
  AND EXISTS (SELECT 1 FROM workshop_sponsors ws WHERE ws.workshop_id = w.id);

-- ROLLBACK:
-- ALTER TABLE clients DROP COLUMN IF EXISTS is_sponsor;
-- ALTER TABLE workshop_sponsors DROP COLUMN IF EXISTS sponsor_title;
-- (sponsor_client_id backfill is correct data and is intentionally not rolled back)
