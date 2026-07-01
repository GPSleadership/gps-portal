-- Migration v78: add phone column to clients (defensive — no-op if already present)
-- GPS Leadership Solutions

ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN clients.phone IS 'Mobile/cell number for SMS check-in reminders. Store as entered; sent in E.164 format via Twilio.';

-- ROLLBACK:
-- ALTER TABLE clients DROP COLUMN IF EXISTS phone;
