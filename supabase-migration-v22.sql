-- GPS Leadership Portal — Migration v22
-- Testimonial & Referral Flywheel
--
-- Creates:
--   1. New columns on clients table (engagement_type, win flag, prompt timestamps)
--   2. testimonials table
--   3. referrals table
--   4. Seed data in gps_settings for referral config
--
-- Run in Supabase SQL editor: Project → SQL Editor → Paste → Run

-- ─── 1. New columns on clients ──────────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS engagement_type TEXT NOT NULL DEFAULT 'diagnostic_only',
  ADD COLUMN IF NOT EXISTS first_big_win_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS debrief_testimonial_prompted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS midpoint_testimonial_prompted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS endof_testimonial_prompted_at TIMESTAMPTZ;

COMMENT ON COLUMN clients.engagement_type IS
  'Track which service tier the client is in: diagnostic_only or diagnostic_plus_coaching.';

COMMENT ON COLUMN clients.first_big_win_flag IS
  'Coach toggles TRUE when the client hits a meaningful first win, triggering the midpoint testimonial prompt.';

COMMENT ON COLUMN clients.debrief_testimonial_prompted_at IS
  'Timestamp when the post-debrief testimonial was last prompted, to prevent duplicate prompting.';

COMMENT ON COLUMN clients.midpoint_testimonial_prompted_at IS
  'Timestamp when the coaching midpoint testimonial was last prompted.';

COMMENT ON COLUMN clients.endof_testimonial_prompted_at IS
  'Timestamp when the end-of-engagement testimonial was last prompted.';

-- Backfill: existing coaching clients get the coaching engagement type
UPDATE clients
  SET engagement_type = 'diagnostic_plus_coaching'
  WHERE in_coaching_program = TRUE;

-- ─── 2. testimonials table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS testimonials (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  engagement_type      TEXT NOT NULL DEFAULT 'diagnostic_only',
  source               TEXT NOT NULL,
  responses            JSONB NOT NULL DEFAULT '{}',
  rating_nps           INTEGER CHECK (rating_nps IS NULL OR (rating_nps >= 0 AND rating_nps <= 10)),
  permission_public_use BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN testimonials.source IS
  'Which touchpoint triggered the testimonial: diagnostic_debrief, coaching_midpoint, or engagement_end.';

COMMENT ON COLUMN testimonials.responses IS
  'JSONB map of question text to answer text, e.g. {"What changed for you?": "I delegated more effectively."}';

COMMENT ON COLUMN testimonials.rating_nps IS
  'Net Promoter Score (0–10). Used to gate referral eligibility (>= 9 qualifies).';

COMMENT ON COLUMN testimonials.permission_public_use IS
  'Coach toggles TRUE when client has given explicit permission to use testimonial publicly.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_testimonials_client_id
  ON testimonials (client_id);

CREATE INDEX IF NOT EXISTS idx_testimonials_client_source
  ON testimonials (client_id, source);

-- ─── 3. referrals table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referrals (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  referral_name             TEXT NOT NULL,
  referral_email            TEXT NOT NULL,
  referral_org              TEXT,
  engagement_type_suggested TEXT DEFAULT 'diagnostic_only',
  email_subject             TEXT,
  email_body                TEXT,
  status                    TEXT NOT NULL DEFAULT 'draft_email_created',
  sent_at                   TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN referrals.email_body IS
  'Pre-generated mailto body assembled by the API, ready for the client to copy or send.';

COMMENT ON COLUMN referrals.status IS
  'draft_email_created → sent → responded → converted';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_client_id
  ON referrals (referrer_client_id);

-- ─── 4. Seed referral config into gps_settings ──────────────────────────────

INSERT INTO gps_settings (key, value, updated_at)
VALUES
  ('referral_bonus_label',          'an additional month of one-on-one leadership coaching',                                  NOW()),
  ('referral_bonus_value_display',  '$5,000',                                                                                  NOW()),
  ('referral_bonus_conditions_text','once one of your introductions completes a 14-Day Executive Leadership Diagnostic',       NOW()),
  ('coaching_access_description',   'direct access to Alex via scheduled sessions and weekday support',                       NOW())
ON CONFLICT (key) DO NOTHING;

-- Verify
SELECT 'Migration v22 complete — Testimonial & Referral Flywheel tables created' AS status;
