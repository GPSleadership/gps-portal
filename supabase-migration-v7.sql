-- GPS Leadership — Supabase Migration v7
-- Adds last_active_at to clients for 45-day auto-archive tracking.
--
-- last_active_at is updated by client.html whenever a client takes any action
-- in their portal: check-in submit, Ask Alex question, plan submit, or stakeholder confirm.
-- The daily cron in survey-reminders.js will auto-archive clients where
-- COALESCE(last_active_at, created_at) < 45 days ago.
--
-- Run this in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Backfill from most recent check-in (best proxy for last activity)
UPDATE clients c
SET last_active_at = (
  SELECT MAX(submitted_at)
  FROM checkins ch
  WHERE ch.client_id = c.id
)
WHERE last_active_at IS NULL;

-- Index to speed up the daily cron query
CREATE INDEX IF NOT EXISTS idx_clients_last_active_at
  ON clients (last_active_at)
  WHERE is_archived = false;
