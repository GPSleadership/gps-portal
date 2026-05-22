-- GPS Leadership Solutions — 90-Day Portal
-- Supabase Database Setup
-- EA: copy and paste this entire file into Supabase → SQL Editor → New query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- CLIENTS TABLE
-- One row per client. EA creates rows manually (or via coach dashboard).
CREATE TABLE IF NOT EXISTS clients (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  token               TEXT        UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  name                TEXT        NOT NULL,
  email               TEXT,
  organization        TEXT,
  is_active           BOOLEAN     DEFAULT true,

  -- Plan fields (populated by client via Form B)
  tp3_pillar          TEXT,           -- 'Trust', 'Proactivity', or 'Productivity'
  goal_description    TEXT,
  goal_statement      TEXT,
  metric_name         TEXT,
  metric_baseline     NUMERIC,
  metric_target       NUMERIC,
  metric_current      NUMERIC,        -- updated on each check-in
  plan_start_date     DATE,
  start_behavior      TEXT,
  reward_30_day       TEXT,
  reward_90_day       TEXT,
  plan_submitted_at   TIMESTAMPTZ,    -- null = client has not yet completed Form B

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- CHECKINS TABLE
-- One row per weekly check-in submission (Form A).
CREATE TABLE IF NOT EXISTS checkins (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id           UUID        REFERENCES clients(id) ON DELETE CASCADE,
  week_number         INTEGER     NOT NULL CHECK (week_number BETWEEN 1 AND 13),
  attended_coaching   BOOLEAN,
  planned_action      TEXT,           -- this week's commitment
  completion_status   TEXT CHECK (completion_status IN ('Yes', 'Partially', 'No')),
  metric_value        NUMERIC,
  notes               TEXT,
  submitted_at        TIMESTAMPTZ DEFAULT NOW()
);

-- INDEX for fast client lookups by token (this runs on every portal page load)
CREATE INDEX IF NOT EXISTS idx_clients_token     ON clients(token);
CREATE INDEX IF NOT EXISTS idx_checkins_client   ON checkins(client_id);
CREATE INDEX IF NOT EXISTS idx_checkins_week     ON checkins(client_id, week_number);

-- AUTO-UPDATE updated_at on clients
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON clients;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- For V1, we disable RLS and rely on token-based URL obscurity.
-- This is appropriate for leadership coaching data (not financial/medical).
-- Enable RLS in a future version if you add sensitive data.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE clients  DISABLE ROW LEVEL SECURITY;
ALTER TABLE checkins DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- SAMPLE DATA (optional — delete before going live)
-- Uncomment to create a test client and verify the portal works end-to-end.
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT INTO clients (name, email, organization, token)
-- VALUES ('Test Client', 'test@example.com', 'Test Org', 'TESTTOKEN123456789');
--
-- After running, visit:
-- https://YOUR_DOMAIN/client.html?token=TESTTOKEN123456789
-- ─────────────────────────────────────────────────────────────────────────────
