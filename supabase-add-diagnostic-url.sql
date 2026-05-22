-- Run in Supabase → SQL Editor → New query
-- Adds per-client Diagnostic Report URL field

ALTER TABLE clients ADD COLUMN IF NOT EXISTS diagnostic_report_url TEXT;
