-- GPS Leadership — Supabase Migration v8
-- Adds portal_first_active_at to clients for 90-day access window tracking.
--
-- portal_first_active_at is set by client.html on the client's very first
-- portal login (when the field is null). It drives the 90-day expiry window
-- for non-coaching clients, along with the day-85 notice and persistent banner.
--
-- Run this in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS portal_first_active_at TIMESTAMPTZ;

-- Index to speed up expiry checks
CREATE INDEX IF NOT EXISTS idx_clients_portal_first_active_at
  ON clients (portal_first_active_at);
