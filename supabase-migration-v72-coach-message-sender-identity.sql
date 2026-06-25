-- v72: attribute coach messages to the actual sender (owner Alex vs assistant Anna)
-- Applied to prod 2026-06-25. Enables per-sender attribution in the portal + email.
ALTER TABLE coach_messages
  ADD COLUMN IF NOT EXISTS sender_name     text,
  ADD COLUMN IF NOT EXISTS sender_admin_id integer;

COMMENT ON COLUMN coach_messages.sender_name IS
  'Display name of the coach-side sender (e.g. Alex Tremble, Anna). NULL for legacy rows = treat as Alex.';
COMMENT ON COLUMN coach_messages.sender_admin_id IS
  'admin_accounts.id of the sender when an assistant sent it; NULL = owner/Alex or legacy.';
