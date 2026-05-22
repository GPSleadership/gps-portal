-- Run this in Supabase → SQL Editor → New query
-- Adds the 30-Day Goal field to existing clients table

ALTER TABLE clients ADD COLUMN IF NOT EXISTS goal_30_day TEXT;
