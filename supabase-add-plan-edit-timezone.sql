-- GPS Portal — Plan Edit Unlock + Timezone
-- Run in Supabase → SQL Editor → New query

ALTER TABLE clients ADD COLUMN IF NOT EXISTS allow_plan_edit BOOLEAN DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';
