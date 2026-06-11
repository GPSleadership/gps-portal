-- Migration v48: add workshop_participants.last_reminder_at
-- Applied: 2026-06-09. Additive.
-- Why: api/workshop-data.js `get-roster` SELECTs last_reminder_at (used for the
-- "reminder_sent" status). The column was missing, so the REST query errored and the
-- endpoint returned an EMPTY participant list — the roster showed 0 for every workshop,
-- even when participants were uploaded successfully. Adding the column fixes it.

ALTER TABLE workshop_participants
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

-- ROLLBACK:
-- ALTER TABLE workshop_participants DROP COLUMN IF EXISTS last_reminder_at;
