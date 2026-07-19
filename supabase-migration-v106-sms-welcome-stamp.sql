-- v106 — one-time SMS opt-in confirmation stamp
-- Records when the "you're now subscribed" confirmation text was sent to a client,
-- so we never double-fire it. Set server-side only (api/portal-data.js update-client),
-- never client-writable. Additive; old code ignores the new column.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS sms_welcome_sent_at timestamptz;

-- ROLLBACK:
-- ALTER TABLE clients DROP COLUMN IF EXISTS sms_welcome_sent_at;
