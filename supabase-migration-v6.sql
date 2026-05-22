-- GPS Leadership — Supabase Migration v6
-- Adds coaching_sessions_enabled flag to clients table.
--
-- When true: client portal shows "Did you attend your coaching session?" in the
--            weekly check-in, and the 13-week stats block shows coaching attendance.
-- When false (default): that question is hidden entirely.
--
-- Run this in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS coaching_sessions_enabled BOOLEAN DEFAULT false;
