-- Migration v47: engagement roles (Sponsor vs POC) + question-review flow foundation
-- Applied: 2026-06-09. Additive only — old code ignores every new column.
-- Design (confirmed): Sponsor = results owner (+ may do logistics); POC = logistics only,
-- NEVER sees results/report. One person can be both. Applies to workshops/assessments AND
-- diagnostics. The portal gates surfaces by role; results require sponsor/leader.

-- 1) Role + per-contact access token on workshop contacts.
ALTER TABLE workshop_sponsors
  ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'sponsor',
  ADD COLUMN IF NOT EXISTS access_token text;

UPDATE workshop_sponsors
  SET access_token = replace(gen_random_uuid()::text, '-', '')
  WHERE access_token IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workshop_sponsors_role_chk') THEN
    ALTER TABLE workshop_sponsors
      ADD CONSTRAINT workshop_sponsors_role_chk CHECK (role IN ('sponsor', 'poc'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS workshop_sponsors_access_token_idx
  ON workshop_sponsors(access_token);

-- 2) POC on diagnostics (single coordinator: provides raters + reviews questions, no report access).
ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS poc_name  text,
  ADD COLUMN IF NOT EXISTS poc_email text,
  ADD COLUMN IF NOT EXISTS poc_token text;

CREATE UNIQUE INDEX IF NOT EXISTS diagnostics_poc_token_idx
  ON diagnostics(poc_token) WHERE poc_token IS NOT NULL;

-- 3) Question-review flow status (both products).
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS questions_review_status  text NOT NULL DEFAULT 'not_sent', -- not_sent | pending | approved | changes_requested
  ADD COLUMN IF NOT EXISTS questions_review_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS questions_review_done_at timestamptz;

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS questions_review_status  text NOT NULL DEFAULT 'not_sent',
  ADD COLUMN IF NOT EXISTS questions_review_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS questions_review_done_at timestamptz;

-- 4) Per-question client decision (the review loop writes these).
ALTER TABLE workshop_questions
  ADD COLUMN IF NOT EXISTS client_decision text,  -- approved | change_requested | (null = not reviewed)
  ADD COLUMN IF NOT EXISTS client_note     text;

-- ROLLBACK:
-- ALTER TABLE workshop_questions DROP COLUMN IF EXISTS client_decision, DROP COLUMN IF EXISTS client_note;
-- ALTER TABLE diagnostics DROP COLUMN IF EXISTS questions_review_status, DROP COLUMN IF EXISTS questions_review_sent_at, DROP COLUMN IF EXISTS questions_review_done_at, DROP COLUMN IF EXISTS poc_name, DROP COLUMN IF EXISTS poc_email, DROP COLUMN IF EXISTS poc_token;
-- ALTER TABLE workshops DROP COLUMN IF EXISTS questions_review_status, DROP COLUMN IF EXISTS questions_review_sent_at, DROP COLUMN IF EXISTS questions_review_done_at;
-- ALTER TABLE workshop_sponsors DROP CONSTRAINT IF EXISTS workshop_sponsors_role_chk; ALTER TABLE workshop_sponsors DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS access_token;
