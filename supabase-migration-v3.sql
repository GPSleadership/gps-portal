-- GPS Leadership Portal — Phase 1: Stakeholder Feedback & Progress Tracking
-- Run this in the Supabase SQL editor.
-- Safe to run multiple times (all statements use IF NOT EXISTS / IF EXISTS guards).

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. stakeholders TABLE
-- Up to 3 stakeholders per client engagement. Supervisor flag determines
-- whether this person is the client's direct supervisor.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stakeholders (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  relationship    TEXT        NOT NULL DEFAULT 'peer',
  -- relationship options: 'supervisor' | 'peer' | 'direct_report' | 'other'
  is_supervisor   BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS stakeholders_client_idx ON stakeholders(client_id);

ALTER TABLE stakeholders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_stakeholders" ON stakeholders;
CREATE POLICY "anon_all_stakeholders" ON stakeholders FOR ALL TO anon USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────────────────────────
-- 2. survey_tokens TABLE
-- One token per stakeholder per checkpoint. Generated at send time.
-- priority_behavior is stored here at token creation so the survey page
-- can display the personalized question without extra lookups.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_tokens (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  token            TEXT        NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  sent_at          TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  used_at          TIMESTAMPTZ,
  client_id        UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stakeholder_id   UUID        NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  checkpoint       TEXT        NOT NULL DEFAULT 'baseline',
  -- checkpoint options: 'baseline' | 'day45' | 'day90'
  priority_behavior TEXT,
  -- The client's behavior_1 text, stored at send time.
  -- Example: "delegate daily decisions to my operations manager without checking in"
  -- Inserted into: "In the last 2 weeks, how consistently did I [priority_behavior]?"
  client_first_name TEXT,
  -- Stored for the email greeting and survey intro display
  is_used          BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS survey_tokens_token_idx      ON survey_tokens(token);
CREATE INDEX IF NOT EXISTS survey_tokens_client_idx     ON survey_tokens(client_id);
CREATE INDEX IF NOT EXISTS survey_tokens_stakeholder_idx ON survey_tokens(stakeholder_id);

ALTER TABLE survey_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_survey_tokens" ON survey_tokens;
CREATE POLICY "anon_all_survey_tokens" ON survey_tokens FOR ALL TO anon USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────────────────────────
-- 3. survey_responses TABLE
-- One row per stakeholder per checkpoint.
-- score: 1–10 rating on the priority behavior question (required at all checkpoints)
-- open_response: text answer to the open-ended question (baseline + day90 only)
-- comments: optional free-text at all checkpoints
-- comments_visible_to_client: stakeholder chooses; default true (shared with coach + client)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_responses (
  id                        UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  submitted_at              TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  client_id                 UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stakeholder_id            UUID        NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  token_id                  UUID        REFERENCES survey_tokens(id) ON DELETE SET NULL,
  checkpoint                TEXT        NOT NULL DEFAULT 'baseline',
  score                     INTEGER     NOT NULL CHECK (score >= 1 AND score <= 10),
  -- 1–10 rating: "In the last 2 weeks, how consistently did I [priority_behavior]?"
  open_response             TEXT,
  -- Baseline prompt: "In one sentence, what's the most noticeable way my current
  --   behavior around [priority] affects you or the team? Please share a recent example."
  -- Day 90 prompt:   "In one sentence, what's the most noticeable change you've experienced
  --   in the last 2–4 weeks around [priority]? Please share a recent example."
  -- NULL at Day 45 (rating only)
  comments                  TEXT,
  -- Optional free text at all checkpoints
  comments_visible_to_client BOOLEAN    NOT NULL DEFAULT TRUE
  -- TRUE = visible to coach + client (default)
  -- FALSE = visible to coach only
);

CREATE INDEX IF NOT EXISTS survey_responses_client_idx      ON survey_responses(client_id);
CREATE INDEX IF NOT EXISTS survey_responses_stakeholder_idx ON survey_responses(stakeholder_id);
CREATE INDEX IF NOT EXISTS survey_responses_checkpoint_idx  ON survey_responses(checkpoint);

ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_survey_responses" ON survey_responses;
CREATE POLICY "anon_all_survey_responses" ON survey_responses FOR ALL TO anon USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────────────────────────
-- 4. RPC: get_survey_scoreboard
-- Returns average score per checkpoint for a given client.
-- Used by coach portal scoreboard view.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_survey_scoreboard(p_client_id UUID)
RETURNS TABLE (
  checkpoint      TEXT,
  response_count  BIGINT,
  avg_score       NUMERIC(4,2),
  last_submitted  TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    checkpoint,
    COUNT(*)                   AS response_count,
    ROUND(AVG(score), 2)       AS avg_score,
    MAX(submitted_at)          AS last_submitted
  FROM survey_responses
  WHERE client_id = p_client_id
  GROUP BY checkpoint
  ORDER BY
    CASE checkpoint
      WHEN 'baseline' THEN 1
      WHEN 'day45'    THEN 2
      WHEN 'day90'    THEN 3
    END;
$$;
