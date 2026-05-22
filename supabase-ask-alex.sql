-- GPS Leadership Portal — Ask Alex: Usage Tracking + Consent
-- Run this in the Supabase SQL editor.
-- Safe to run multiple times (all statements use IF NOT EXISTS / IF EXISTS guards).

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. ask_alex_usage TABLE
-- Detailed log of every Ask Alex interaction.
-- Kept separate from clients table so you can query time-range stats without
-- touching the main client record. Counters on the client record (below) give
-- instant dashboard reads without scanning this table every time.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ask_alex_usage (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asked_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  question_length INTEGER,    -- character count of the question (optional)
  metadata        JSONB       -- reserved for future: thumbs_up/down, topic_category, etc.
  -- Future metadata examples (no code changes needed, just populate the JSON):
  --   {"thumbs": "up"}
  --   {"thumbs": "down", "comment": "too generic"}
  --   {"topic_category": "delegation"}
  --   {"needs_human_followup": true}
  --   {"weekly_report_eligible": true}
);

CREATE INDEX IF NOT EXISTS ask_alex_usage_client_idx  ON ask_alex_usage(client_id);
CREATE INDEX IF NOT EXISTS ask_alex_usage_asked_at_idx ON ask_alex_usage(asked_at);

ALTER TABLE ask_alex_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_ask_alex_usage" ON ask_alex_usage;
CREATE POLICY "anon_all_ask_alex_usage" ON ask_alex_usage FOR ALL TO anon USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────────────────────────
-- 2. DENORMALIZED COUNTERS on clients
-- Kept in sync on every question (via the RPC below).
-- These let the coach dashboard show total + last-used WITHOUT a join.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ask_alex_total_questions INTEGER     DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ask_alex_last_used_at    TIMESTAMPTZ;


-- ──────────────────────────────────────────────────────────────────────────────
-- 3. CONSENT TRACKING on clients
-- ai_terms_version stores the version the client accepted (e.g. "v1.0").
-- When you bump to "v1.1", set ai_terms_accepted = false for all clients and
-- they will see the modal again on next Ask Alex launch.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_terms_version      TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_terms_accepted      BOOLEAN     DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ai_terms_accepted_at   TIMESTAMPTZ;


-- ──────────────────────────────────────────────────────────────────────────────
-- 4. RPC: increment_ask_alex
-- Atomically increments the counter and sets last_used_at.
-- Called by api/ask.js after each successful AI response.
-- Using an RPC (instead of a read-then-write from Node) prevents race conditions
-- if two questions arrive close together.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_ask_alex(p_client_id UUID, p_asked_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE clients
  SET
    ask_alex_total_questions = COALESCE(ask_alex_total_questions, 0) + 1,
    ask_alex_last_used_at    = p_asked_at
  WHERE id = p_client_id;
$$;
