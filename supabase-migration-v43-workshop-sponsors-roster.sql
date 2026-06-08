-- Migration v43: workshop_sponsors junction + roster upload + unified sponsor link
-- Applied: 2026-06-08
-- Purpose:
--   1. Allow multiple sponsors per workshop (workshop_sponsors junction)
--   2. Roster upload tracking on workshops (roster_locked, roster_file_url)
--   3. Link Decision Room sponsors to client records for unified portal access

-- 1. workshop_sponsors junction table
CREATE TABLE IF NOT EXISTS workshop_sponsors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id  uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id)   ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workshop_id, client_id)
);
ALTER TABLE workshop_sponsors ENABLE ROW LEVEL SECURITY;
-- service-role only; no anon policies

-- Backfill existing single-sponsor workshops into the junction
INSERT INTO workshop_sponsors (workshop_id, client_id)
SELECT id, sponsor_client_id
FROM workshops
WHERE sponsor_client_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2. Roster upload columns on workshops
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS roster_locked    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS roster_file_url  text,
  ADD COLUMN IF NOT EXISTS roster_uploaded_at timestamptz;

-- 3. Link Decision Room sponsors → clients for unified portal
ALTER TABLE sponsors
  ADD COLUMN IF NOT EXISTS linked_client_id uuid REFERENCES clients(id) ON DELETE SET NULL;

-- ROLLBACK:
-- ALTER TABLE sponsors DROP COLUMN IF EXISTS linked_client_id;
-- ALTER TABLE workshops
--   DROP COLUMN IF EXISTS roster_locked,
--   DROP COLUMN IF EXISTS roster_file_url,
--   DROP COLUMN IF EXISTS roster_uploaded_at;
-- DROP TABLE IF EXISTS workshop_sponsors;
