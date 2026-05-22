-- GPS Leadership — Supabase Migration v11
-- Adds client profile fields: preferred_name, title, org, phone, sms_opt_in, timezone.
--
-- preferred_name: how the client wants to be addressed throughout the portal.
--   Displayed in the header greeting, plan page subheading, and Ask Alex intro.
--   Falls back to first word of `name` if not set.
--
-- title: client's job title (e.g. "CEO", "Senior VP of Operations").
--   Stored for profile completeness; used in future personalization.
--
-- org: client's organization name.
--   Stored for reference; not currently displayed in portal UI.
--
-- phone: optional mobile number for SMS reminders.
--   Format: E.164 preferred (e.g. +15551234567).
--   Only collected if client opts in.
--
-- sms_opt_in: explicit consent for SMS notifications.
--   Must be TRUE before any SMS is sent. No exceptions.
--   Default FALSE — client self-sets via Profile modal in the portal.
--   Reminder system check: sms_opt_in = TRUE AND phone IS NOT NULL.
--
-- timezone: IANA timezone string (e.g. "America/New_York").
--   Used by reminder system to send SMS at appropriate local time.
--   Default 'America/New_York'.
--
-- SMS send logic lives in api/survey-reminders.js (Twilio integration — pending).
-- Look for: // SMS_HOOK — send SMS reminder here when Twilio is wired
--
-- Run each statement separately in the Supabase SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS title TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS org TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';
