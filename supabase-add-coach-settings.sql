-- GPS Portal — Coach Settings Table
-- Run in Supabase → SQL Editor → New query
-- Stores the coach password dynamically so it can be changed via the UI

CREATE TABLE IF NOT EXISTS coach_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the initial password (change 'GPS2026' if you've already updated it)
INSERT INTO coach_settings (key, value)
VALUES ('coach_password', 'GPS2026')
ON CONFLICT (key) DO NOTHING;

-- Used to store a temporary verification code during password change
INSERT INTO coach_settings (key, value)
VALUES ('pending_code', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO coach_settings (key, value)
VALUES ('pending_code_expires', '')
ON CONFLICT (key) DO NOTHING;
