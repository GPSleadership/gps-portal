-- GPS Portal Migration v18
-- Ask Alex Logger: full question + response capture
-- Run in Supabase SQL Editor

-- 1. Create ask_alex_log table
CREATE TABLE IF NOT EXISTS ask_alex_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  question_text   TEXT,
  response_text   TEXT,
  sprint_number   INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER
);

-- 2. Performance indexes
CREATE INDEX IF NOT EXISTS idx_ask_alex_log_client_id
  ON ask_alex_log (client_id, asked_at DESC);

CREATE INDEX IF NOT EXISTS idx_ask_alex_log_asked_at
  ON ask_alex_log (asked_at DESC);

-- 3. RLS
ALTER TABLE ask_alex_log ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by api/ask.js to INSERT)
CREATE POLICY "service_role_all" ON ask_alex_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Anon can SELECT (coach.html reads with anon key — secured by app-level coach password)
CREATE POLICY "anon_select" ON ask_alex_log
  FOR SELECT
  TO anon
  USING (true);

-- Anon cannot INSERT/UPDATE/DELETE — inserts come only from server-side api/ask.js

-- Verify
SELECT 'ask_alex_log table created' AS status;
