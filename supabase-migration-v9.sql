-- GPS Leadership — Supabase Migration v9
-- Adds continuation_step to clients for the 5-day post-expiry email sequence.
--
-- continuation_step tracks which email in the sequence has been sent:
--   0 = not started
--   1 = Day 1 AM sent  (portal access pauses tomorrow)
--   2 = Day 1 PM sent  (before your access closes tonight)
--   3 = Day 2 sent     (holding a few spots for this cohort)
--   4 = Day 3 sent     (example of how leaders use this work)
--   5 = Day 5 sent     (quick question about the portal) — sequence complete
--
-- Only applies to non-coaching clients (is_coaching_client = false).
-- Incremented by api/survey-reminders.js daily cron after each successful send.
--
-- Run this in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS continuation_step INT NOT NULL DEFAULT 0;
