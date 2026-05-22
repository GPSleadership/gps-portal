-- GPS Leadership — Supabase Migration v10
-- Adds welcome_sent_at and welcome_reminder_step for the welcome reminder sequence.
--
-- welcome_sent_at is set by coach.html the moment the welcome email is sent.
-- It drives the 3-reminder sequence for clients who haven't completed Form B.
--
-- welcome_reminder_step tracks which reminder has been sent:
--   0 = no reminders sent (default)
--   1 = Day 2 reminder sent
--   2 = Day 4 reminder sent
--   3 = Day 6 reminder sent — client is auto-archived after this
--
-- Only fires for non-archived clients with welcome_sent_at set and plan_submitted_at null.
-- Incremented by api/survey-reminders.js daily cron after each successful send.
--
-- Run each statement separately in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS welcome_reminder_step INT NOT NULL DEFAULT 0;
