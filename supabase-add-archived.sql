-- Run this in Supabase → SQL Editor → New query
-- Adds soft-delete (archive) support to the clients table

ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- Set any existing NULL values to false (safety net for old rows)
UPDATE clients SET is_archived = FALSE WHERE is_archived IS NULL;

-- Optional: index for faster filtering (recommended if you have 100+ clients)
CREATE INDEX IF NOT EXISTS idx_clients_is_archived ON clients (is_archived);
