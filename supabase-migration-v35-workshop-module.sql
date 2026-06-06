-- ============================================================================
-- GPS Leadership Portal — Migration v35: WORKSHOP MODULE
-- ============================================================================
--
--  Adds the Workshop engagement model on top of the existing schema.
--
--  Security posture (unchanged since v26): every table has RLS ENABLED with NO
--  anon policies. The anon role is denied by default; ONLY the service_role key
--  (used by the api/*.js serverless endpoints) reaches these tables. These new
--  tables follow the same posture: RLS enabled, zero policies = deny-all.
--
--  ONE PROFILE PER PERSON (Alex's rule):
--    • A workshop SPONSOR/leader is an existing `clients` row
--      (workshops.sponsor_client_id → clients.id).
--    • A workshop PARTICIPANT is also a `clients` row, joined in via
--      workshop_participants. Workshop-only people are flagged on clients with
--      is_workshop_participant = TRUE so they never clutter the coaching list.
--    • Stacking a diagnostic or coaching engagement later reuses the SAME
--      clients profile — it just gains tabs/roles. Never create a duplicate
--      person record.
--
--  REUSE, DON'T DUPLICATE:
--    • testimonials / referrals already have the right shape (engagement_type,
--      source, responses JSONB, rating_nps, permission_public_use). We add a
--      nullable workshop_id to each for attribution and reuse them as-is.
--      (testimonials.source is free TEXT — no CHECK to alter; 'workshop_debrief'
--      drops in cleanly.)
--
--  What is genuinely NEW (the workshop lifecycle, its question bank, and its
--  response store) gets its own tables below.
--
--  Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). ROLLBACK at the bottom.
-- ============================================================================

BEGIN;

-- ── workshops ────────────────────────────────────────────────────────────────
-- One workshop engagement, from pre-survey through post-workshop debrief.
-- `status` is intentionally free TEXT (matches diagnostics.status) so the
-- lifecycle can evolve without a constraint-altering migration. Documented flow:
--   setup → discovery_complete → questions_drafted → sponsor_review
--   → pre_survey_open → pre_survey_closed → workshop_delivered
--   → post_survey_open → post_survey_closed → debrief_scheduled
--   → report_uploaded → complete
CREATE TABLE IF NOT EXISTS workshops (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_org_name     TEXT,
  title               TEXT NOT NULL,
  workshop_date       DATE,
  debrief_date        DATE,
  -- The sponsor/leader is a clients profile (one profile per person).
  sponsor_client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Token-gated, read-only sponsor dashboard access (mirrors sponsors.sponsor_token).
  sponsor_token       TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  token_last_used_at  TIMESTAMPTZ,
  -- Segmentation / tagging
  industry            TEXT,
  company_size_band   TEXT,
  audience_level      TEXT CHECK (audience_level IS NULL OR audience_level IN ('executive','manager')),
  tags                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["trucking","federal",...]
  -- Lifecycle (free text, documented above)
  status              TEXT NOT NULL DEFAULT 'setup',
  is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review        BOOLEAN NOT NULL DEFAULT FALSE,        -- set on borderline/red-flag sponsor NPS
  -- Confidentiality (future-proofing; mirrors the Decision Room model)
  confidentiality_mode TEXT NOT NULL DEFAULT 'standard'
                      CHECK (confidentiality_mode IN ('standard','private')),
  -- Survey windows
  pre_survey_open_at   TIMESTAMPTZ,
  pre_survey_close_at  TIMESTAMPTZ,
  post_survey_open_at  TIMESTAMPTZ,
  post_survey_close_at TIMESTAMPTZ,
  -- Discovery inputs (used by the AI question-suggestion step)
  discovery_notes      TEXT,
  discovery_transcript TEXT,
  -- Computed / AI-authored, coach-reviewed
  exec_summary_json    JSONB,   -- { participation, nps, tp3:{...}, strengths:[], risks:[], focus90:[] }
  recommendation_json  JSONB,   -- { primary_step, rationale, rules_fired:[] }
  bonus_resource_config JSONB,  -- { label, url } — the promoter "bonus unlocked" asset
  recap_sent_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workshop_participants ────────────────────────────────────────────────────
-- Joins an existing clients row (the unified person profile) to a workshop.
-- participant_token is the survey access key AND the save-and-resume magic link.
CREATE TABLE IF NOT EXISTS workshop_participants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id        UUID NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role               TEXT,
  location           TEXT,
  department         TEXT,
  participant_token  TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  pre_status         TEXT NOT NULL DEFAULT 'not_started'
                     CHECK (pre_status IN ('not_started','in_progress','complete')),
  post_status        TEXT NOT NULL DEFAULT 'not_started'
                     CHECK (post_status IN ('not_started','in_progress','complete')),
  invited_at         TIMESTAMPTZ,
  pre_completed_at   TIMESTAMPTZ,
  post_completed_at  TIMESTAMPTZ,
  email_bounced      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workshop_id, client_id)
);

-- ── workshop_questions ───────────────────────────────────────────────────────
-- The question bank. workshop_id NULL = a global standard template row that the
-- coach can copy into a workshop. Separate pre/post sets via `phase`.
-- AI-suggested questions land as status='draft' and must be coach-approved
-- (status='approved'/'live') before participants see them.
CREATE TABLE IF NOT EXISTS workshop_questions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id        UUID REFERENCES workshops(id) ON DELETE CASCADE,  -- NULL = global template
  question_id        TEXT NOT NULL,                 -- stable id, unique within (workshop_id, phase)
  question_theme     TEXT,                          -- trust|proactivity|productivity|delegation|meetings|communication|...
  phase              TEXT NOT NULL CHECK (phase IN ('pre','post')),
  question_text      TEXT NOT NULL,
  response_type      TEXT NOT NULL DEFAULT 'scale'
                     CHECK (response_type IN ('numeric','scale','text')),
  scale_min          INTEGER,
  scale_max          INTEGER,
  version            INTEGER NOT NULL DEFAULT 1,
  source             TEXT NOT NULL DEFAULT 'standard'
                     CHECK (source IN ('standard','custom','ai_suggested')),
  status             TEXT NOT NULL DEFAULT 'approved'
                     CHECK (status IN ('draft','approved','live','rejected')),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workshop_responses ───────────────────────────────────────────────────────
-- The response store. Matches the requested schema. `phase` includes 'feedback'
-- for the post-debrief sponsor satisfaction/NPS survey (participant_id NULL,
-- sponsor_id set). response_value is numeric for scale/numeric items;
-- response_text for free-text items.
CREATE TABLE IF NOT EXISTS workshop_responses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id        UUID NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  participant_id     UUID REFERENCES workshop_participants(id) ON DELETE CASCADE,
  sponsor_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  question_id        TEXT,
  question_text      TEXT,
  question_theme     TEXT,
  phase              TEXT NOT NULL DEFAULT 'pre'
                     CHECK (phase IN ('pre','post','feedback')),
  response_value     NUMERIC,
  response_text      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Reused tables: testimonials & referrals ──────────────────────────────────
-- IMPORTANT: the live production DB does NOT currently have testimonials/referrals
-- (migration v22 was documented as applied but is absent in production). To keep
-- the workshop flywheel self-sufficient and idempotent across every environment,
-- we CREATE them IF NOT EXISTS with the v22 shape PLUS a nullable workshop_id,
-- then ensure workshop_id exists on any environment where the tables predate this
-- migration. A nullable workshop_id ties a workshop-sourced testimonial/referral
-- back to its workshop without disturbing existing (diagnostic/coaching) rows.
CREATE TABLE IF NOT EXISTS testimonials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  engagement_type       TEXT NOT NULL DEFAULT 'diagnostic_only',
  source                TEXT NOT NULL,
  responses             JSONB NOT NULL DEFAULT '{}',
  rating_nps            INTEGER CHECK (rating_nps IS NULL OR (rating_nps >= 0 AND rating_nps <= 10)),
  permission_public_use BOOLEAN DEFAULT FALSE,
  workshop_id           UUID REFERENCES workshops(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT now()
);
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
  workshop_id               UUID REFERENCES workshops(id) ON DELETE SET NULL,
  sent_at                   TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT now()
);
-- Cover environments where the tables predate this migration (add the column).
ALTER TABLE testimonials ADD COLUMN IF NOT EXISTS workshop_id UUID REFERENCES workshops(id) ON DELETE SET NULL;
ALTER TABLE referrals    ADD COLUMN IF NOT EXISTS workshop_id UUID REFERENCES workshops(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_testimonials_client_id ON testimonials (client_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer     ON referrals (referrer_client_id);

-- clients gains a flag so workshop-only people stay out of the coaching list.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_workshop_participant BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN clients.is_workshop_participant IS
  'TRUE for people added only as workshop participants. Keeps them out of the coaching client list; cleared/ignored once they take on a coaching or diagnostic engagement.';

-- ── indexes for endpoint lookups ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_workshops_sponsor_token   ON workshops (sponsor_token);
CREATE INDEX IF NOT EXISTS idx_workshops_sponsor_client  ON workshops (sponsor_client_id);
CREATE INDEX IF NOT EXISTS idx_workshops_status          ON workshops (status);
CREATE INDEX IF NOT EXISTS idx_wparticipants_workshop    ON workshop_participants (workshop_id);
CREATE INDEX IF NOT EXISTS idx_wparticipants_client      ON workshop_participants (client_id);
CREATE INDEX IF NOT EXISTS idx_wparticipants_token       ON workshop_participants (participant_token);
CREATE INDEX IF NOT EXISTS idx_wquestions_workshop       ON workshop_questions (workshop_id);
CREATE INDEX IF NOT EXISTS idx_wquestions_phase          ON workshop_questions (workshop_id, phase);
CREATE INDEX IF NOT EXISTS idx_wresponses_workshop       ON workshop_responses (workshop_id);
CREATE INDEX IF NOT EXISTS idx_wresponses_workshop_phase ON workshop_responses (workshop_id, phase);
CREATE INDEX IF NOT EXISTS idx_wresponses_participant    ON workshop_responses (participant_id);
CREATE INDEX IF NOT EXISTS idx_testimonials_workshop     ON testimonials (workshop_id);
CREATE INDEX IF NOT EXISTS idx_referrals_workshop        ON referrals (workshop_id);

-- ── RLS: enable, no policies = deny-all to anon (service role bypasses) ───────
ALTER TABLE workshops             ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_questions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_responses    ENABLE ROW LEVEL SECURITY;

-- testimonials/referrals may have just been created here — lock them down too
-- (no-op if they already existed and were locked at v26).
ALTER TABLE testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals    ENABLE ROW LEVEL SECURITY;

-- Belt-and-suspenders: make sure the public roles hold no table grants either.
REVOKE ALL ON workshops, workshop_participants, workshop_questions, workshop_responses
  FROM anon, authenticated;
REVOKE ALL ON testimonials, referrals FROM anon, authenticated;

-- ── Seed the standard TP3-aligned baseline question bank (global templates) ───
-- workshop_id = NULL marks these as copyable templates. The coach tab clones the
-- relevant set into each workshop; AI-suggested and custom questions are added
-- per workshop. Pre and post share themes so deltas line up.
INSERT INTO workshop_questions
  (workshop_id, question_id, question_theme, phase, question_text, response_type, scale_min, scale_max, source, status, sort_order)
SELECT * FROM ( VALUES
  -- PRE (baseline) — 1-5 scale, theme-grouped
  (NULL::uuid, 'TRUST_1',  'trust',         'pre', 'I trust the people I work most closely with to follow through on what they commit to.',                 'scale', 1, 5, 'standard', 'approved', 10),
  (NULL, 'TRUST_2',  'trust',         'pre', 'On this team, people can raise hard issues without it being held against them.',                          'scale', 1, 5, 'standard', 'approved', 20),
  (NULL, 'PROACT_1', 'proactivity',   'pre', 'People here take ownership of problems without waiting to be told.',                                      'scale', 1, 5, 'standard', 'approved', 30),
  (NULL, 'PROACT_2', 'proactivity',   'pre', 'When something is off, we raise it early rather than letting it slide.',                                  'scale', 1, 5, 'standard', 'approved', 40),
  (NULL, 'PROD_1',   'productivity',  'pre', 'Our meetings end with clear decisions and owners.',                                                       'scale', 1, 5, 'standard', 'approved', 50),
  (NULL, 'PROD_2',   'productivity',  'pre', 'I have clarity on the top priorities that matter most right now.',                                        'scale', 1, 5, 'standard', 'approved', 60),
  (NULL, 'DELEG_1',  'delegation',    'pre', 'Decisions get made at the right level instead of bottlenecking at the top.',                              'scale', 1, 5, 'standard', 'approved', 70),
  (NULL, 'MEET_1',   'meetings',      'pre', 'The time we spend in meetings is a good use of the team''s time.',                                        'scale', 1, 5, 'standard', 'approved', 80),
  (NULL, 'COMM_1',   'communication', 'pre', 'Expectations between me and the people I work with are clear and shared.',                               'scale', 1, 5, 'standard', 'approved', 90),
  (NULL, 'OPEN_1',   'open',          'pre', 'What is the single biggest thing slowing this team down right now?',                                      'text',  NULL, NULL, 'standard', 'approved', 100),
  -- POST (same themes, worded for the after-state, so pre→post deltas align)
  (NULL, 'TRUST_1',  'trust',         'post', 'I trust the people I work most closely with to follow through on what they commit to.',                 'scale', 1, 5, 'standard', 'approved', 10),
  (NULL, 'TRUST_2',  'trust',         'post', 'On this team, people can raise hard issues without it being held against them.',                          'scale', 1, 5, 'standard', 'approved', 20),
  (NULL, 'PROACT_1', 'proactivity',   'post', 'People here take ownership of problems without waiting to be told.',                                      'scale', 1, 5, 'standard', 'approved', 30),
  (NULL, 'PROACT_2', 'proactivity',   'post', 'When something is off, we raise it early rather than letting it slide.',                                  'scale', 1, 5, 'standard', 'approved', 40),
  (NULL, 'PROD_1',   'productivity',  'post', 'Our meetings end with clear decisions and owners.',                                                       'scale', 1, 5, 'standard', 'approved', 50),
  (NULL, 'PROD_2',   'productivity',  'post', 'I have clarity on the top priorities that matter most right now.',                                        'scale', 1, 5, 'standard', 'approved', 60),
  (NULL, 'DELEG_1',  'delegation',    'post', 'Decisions get made at the right level instead of bottlenecking at the top.',                              'scale', 1, 5, 'standard', 'approved', 70),
  (NULL, 'MEET_1',   'meetings',      'post', 'The time we spend in meetings is a good use of the team''s time.',                                        'scale', 1, 5, 'standard', 'approved', 80),
  (NULL, 'COMM_1',   'communication', 'post', 'Expectations between me and the people I work with are clear and shared.',                               'scale', 1, 5, 'standard', 'approved', 90),
  (NULL, 'NPS_1',    'satisfaction',  'post', 'How likely are you to recommend a workshop like this to a peer? (0-10)',                                  'numeric', 0, 10, 'standard', 'approved', 95),
  (NULL, 'OPEN_2',   'open',          'post', 'What is the most valuable thing you are taking away from this workshop?',                                  'text',  NULL, NULL, 'standard', 'approved', 100)
) AS seed(workshop_id, question_id, question_theme, phase, question_text, response_type, scale_min, scale_max, source, status, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM workshop_questions WHERE workshop_id IS NULL);

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients      DROP COLUMN IF EXISTS is_workshop_participant;
--   ALTER TABLE referrals    DROP COLUMN IF EXISTS workshop_id;
--   ALTER TABLE testimonials DROP COLUMN IF EXISTS workshop_id;
--   DROP TABLE IF EXISTS workshop_responses;
--   DROP TABLE IF EXISTS workshop_questions;
--   DROP TABLE IF EXISTS workshop_participants;
--   DROP TABLE IF EXISTS workshops;
-- COMMIT;
-- ============================================================================
