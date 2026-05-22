-- ============================================================
-- GPS Leadership Solutions — Migration v4
-- Run this AFTER migration v3 has been applied.
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS guards.
-- ============================================================

-- ── 1. survey_tokens — add reminder + bounce tracking ────────────────────────
ALTER TABLE survey_tokens
  ADD COLUMN IF NOT EXISTS reminder_1_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_2_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_3_sent_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS non_response_flagged BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_bounced        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bounced_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sprint_number        INTEGER DEFAULT 1;

-- ── 2. survey_responses — add sprint_number ─────────────────────────────────
ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS sprint_number INTEGER DEFAULT 1;

-- ── 3. stakeholders — add sprint_number + Board Member support ───────────────
ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS sprint_number    INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_board_member  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_locked        BOOLEAN DEFAULT FALSE;
  -- is_locked = true means coach set this stakeholder and client cannot remove

-- ── 4. self_checks table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS self_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sprint_number INTEGER NOT NULL DEFAULT 1,
  checkpoint    TEXT NOT NULL CHECK (checkpoint IN ('day45', 'day90')),
  q1_score      INTEGER CHECK (q1_score >= 1 AND q1_score <= 10),
  q2_score      INTEGER CHECK (q2_score >= 1 AND q2_score <= 10),
  q3_response   TEXT,
  submitted_at  TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, sprint_number, checkpoint)
);

ALTER TABLE self_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon read self_checks" ON self_checks;
DROP POLICY IF EXISTS "Allow anon insert self_checks" ON self_checks;
CREATE POLICY "Allow anon read self_checks"   ON self_checks FOR SELECT USING (true);
CREATE POLICY "Allow anon insert self_checks" ON self_checks FOR INSERT WITH CHECK (true);

-- ── 5. email_templates table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  is_approved  BOOLEAN DEFAULT FALSE,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon read email_templates" ON email_templates;
CREATE POLICY "Allow anon read email_templates" ON email_templates FOR SELECT USING (true);

-- Seed default templates (INSERT if not exists)
INSERT INTO email_templates (template_key, label, subject, body_text, is_approved)
VALUES
(
  'survey_baseline',
  'Baseline Survey — Initial Email',
  '[ClientFirstName] would value your candid feedback',
  'Hi [StakeholderFirstName],

[ClientFirstName] has started a focused 90-day leadership sprint and has asked you to be one of their key stakeholders.

You''ll find a short 2-question survey here: [SurveyLink]

It should take less than 3 minutes. You''ll be asked to:

1. Rate, on a 1–10 scale, how consistently [ClientFirstName] has [priority behavior] over the last 2 weeks.
2. (Optional) Share one brief example of how their current behavior around [priority behavior] affects you or the team.

This process is for development, not evaluation. Your numeric rating will be visible to both [ClientFirstName] and their coach. For written comments, you can choose whether to share them with both of them or with the coach only.

You''ll notice [ClientFirstName] and their coach are copied here so everyone knows this request was sent.

Thank you in advance for your honest input — it''s a key part of helping [ClientFirstName] change in ways that matter.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
),
(
  'survey_day45',
  'Day 45 Survey — Initial Email',
  'Quick mid-point check-in for [ClientFirstName]',
  'Hi [StakeholderFirstName],

About 45 days ago, [ClientFirstName] began a 90-day leadership sprint focused on [priority behavior]. You previously shared baseline feedback as one of their key stakeholders.

We''re now at the midpoint and would value a quick update from you.

Please complete this very short check-in (1 question): [SurveyLink]

You''ll be asked to rate, on a 1–10 scale, how consistently [ClientFirstName] has [priority behavior] over the last 2 weeks, plus an optional comment field.

Your numeric rating will be visible to both [ClientFirstName] and their coach. For any written comments, you can again choose whether they are shared with both or only with the coach.

[ClientFirstName] and their coach are copied here so everyone knows this request was sent. Your responses are still used for development, not formal evaluation.

Thank you again for your support and candor.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
),
(
  'survey_day90',
  'Day 90 Survey — Initial Email',
  'Final 90-day feedback for [ClientFirstName]',
  'Hi [StakeholderFirstName],

You''ve been part of [ClientFirstName]''s 90-day leadership sprint focused on [priority behavior], and we''re now at the final checkpoint.

To help [ClientFirstName] see what has actually changed from your perspective, please complete this brief survey: [SurveyLink]

You''ll be asked to:

1. Rate, on a 1–10 scale, how consistently [ClientFirstName] has [priority behavior] over the last 2 weeks.
2. Share, in one sentence, the most noticeable change you''ve experienced in the last 2–4 weeks related to [priority behavior], with a brief example if possible.
3. (Optional) Add any additional comments, with the option to share them with both [ClientFirstName] and their coach, or with the coach only.

As before, your numeric rating is visible to both [ClientFirstName] and their coach. Written comments follow the visibility setting you choose. The purpose remains development, not performance evaluation.

[ClientFirstName] and their coach are copied so they know this request has gone out. Your honest feedback is what makes this process meaningful.

Thank you for your time and insight.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
),
(
  'survey_reminder_1',
  'Stakeholder Reminder 1 (Day +2)',
  'Quick reminder: [ClientFirstName] is waiting on your feedback',
  'Hi [StakeholderFirstName],

Just a quick reminder — [ClientFirstName] is waiting on your feedback as part of their 90-day leadership development program.

Your survey link: [SurveyLink]

It takes under 3 minutes. Your honest input matters.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
),
(
  'survey_reminder_2',
  'Stakeholder Reminder 2 (Day +4)',
  'Still waiting on your feedback for [ClientFirstName]',
  'Hi [StakeholderFirstName],

We''re still missing your feedback for [ClientFirstName]''s leadership development program. This is the second reminder.

Your survey link: [SurveyLink]

The survey takes under 3 minutes and directly shapes the coaching work [ClientFirstName] is doing. Your perspective matters.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
),
(
  'survey_reminder_3',
  'Stakeholder Reminder 3 (Day +6) — Final',
  'Final reminder: feedback for [ClientFirstName]',
  'Hi [StakeholderFirstName],

This is the final reminder for [ClientFirstName]''s leadership survey. If you''re not able to complete it, no action is needed — we''ll note your non-response in the program record.

If you are able to take 3 minutes, your link is here: [SurveyLink]

Thank you either way.

Best,
Alex D. Tremble
CEO & Executive Advisor, GPS Leadership Solutions
On behalf of [ClientFirstName]
team@gpsleadership.org',
  FALSE
)
ON CONFLICT (template_key) DO NOTHING;

-- ── 6. sprint_closeouts table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sprint_closeouts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sprint_number          INTEGER NOT NULL DEFAULT 1,
  q1_response            TEXT,  -- "how would you describe the change"
  q2_response            TEXT,  -- "next most important behavior"
  is_coaching_client     BOOLEAN DEFAULT FALSE,
  next_sprint_requested  BOOLEAN DEFAULT FALSE,
  submitted_at           TIMESTAMPTZ DEFAULT now(),
  created_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, sprint_number)
);

ALTER TABLE sprint_closeouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon read sprint_closeouts" ON sprint_closeouts;
DROP POLICY IF EXISTS "Allow anon insert sprint_closeouts" ON sprint_closeouts;
CREATE POLICY "Allow anon read sprint_closeouts"   ON sprint_closeouts FOR SELECT USING (true);
CREATE POLICY "Allow anon insert sprint_closeouts" ON sprint_closeouts FOR INSERT WITH CHECK (true);

-- ── 7. sprints table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sprints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sprint_number   INTEGER NOT NULL DEFAULT 1,
  start_date      DATE NOT NULL,
  end_date        DATE,
  behavior_focus  TEXT,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'complete', 'archived')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (client_id, sprint_number)
);

ALTER TABLE sprints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon read sprints" ON sprints;
DROP POLICY IF EXISTS "Allow anon all sprints" ON sprints;
CREATE POLICY "Allow anon read sprints" ON sprints FOR SELECT USING (true);
CREATE POLICY "Allow anon all sprints"  ON sprints FOR ALL   USING (true);

-- ── 8. clients table — add sprint tracking fields ────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS current_sprint_number INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_active_coaching    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS closeout_submitted_at TIMESTAMPTZ;

-- ── 9. Indexes for performance ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_survey_tokens_reminder    ON survey_tokens (client_id, is_used, non_response_flagged);
CREATE INDEX IF NOT EXISTS idx_self_checks_client        ON self_checks (client_id, sprint_number);
CREATE INDEX IF NOT EXISTS idx_sprint_closeouts_client   ON sprint_closeouts (client_id, sprint_number);
CREATE INDEX IF NOT EXISTS idx_sprints_client            ON sprints (client_id, sprint_number);
