-- ============================================================
-- GPS Leadership Portal — Migration v41
-- TP3 Question Bank — schema columns + 21-question seed
-- Branch: tp3-assessment-v2
-- Applied: after v40, before deploying TP3 Assessment V2
-- ============================================================
--
-- ADDITIVE ONLY. Existing global templates (workshop_id NULL
-- without template_set) are unaffected. The new TP3 seed rows
-- are scoped by template_set = 'tp3_assessment'.
-- ============================================================

-- ── 0. Expand response_type check constraint ────────────────
-- Original constraint only allowed: numeric, scale, text
-- TP3 questions require: choice, nps, open — expand it now.
ALTER TABLE workshop_questions
  DROP CONSTRAINT IF EXISTS workshop_questions_response_type_check;

ALTER TABLE workshop_questions
  ADD CONSTRAINT workshop_questions_response_type_check
  CHECK (response_type = ANY (ARRAY[
    'numeric', 'scale', 'text',
    'choice', 'nps', 'open', 'yesno', 'rating', 'multiple_choice'
  ]));

-- ── 1. Add columns to workshop_questions ────────────────────

-- Scopes global templates: 'tp3_assessment', 'workshop_pre', 'workshop_post', etc.
ALTER TABLE workshop_questions
  ADD COLUMN IF NOT EXISTS template_set TEXT;

-- Flags demographic questions (coach-toggleable per assessment)
ALTER TABLE workshop_questions
  ADD COLUMN IF NOT EXISTS is_demographic BOOLEAN NOT NULL DEFAULT FALSE;

-- Machine-readable key for demographics (e.g. 'name', 'tenure', 'dept')
ALTER TABLE workshop_questions
  ADD COLUMN IF NOT EXISTS demographic_key TEXT;

-- JSON array of choice strings for response_type='choice'
-- e.g. '["Option A","Option B","Option C"]'
ALTER TABLE workshop_questions
  ADD COLUMN IF NOT EXISTS choice_options JSONB;

-- Index for fast template lookups
CREATE INDEX IF NOT EXISTS idx_wq_template_set ON workshop_questions (template_set)
  WHERE workshop_id IS NULL;

-- ── 2. Seed 21-question TP3 base question bank ───────────────
-- Guard: only insert if tp3_assessment templates don't exist yet.
-- Each assessment gets its OWN copy of these seeded by create-assessment
-- action. This table stores the MASTER TEMPLATES only (workshop_id NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workshop_questions
    WHERE workshop_id IS NULL AND template_set = 'tp3_assessment'
  ) THEN

    INSERT INTO workshop_questions
      (question_id, question_theme, question_text, response_type,
       scale_min, scale_max, source, status, sort_order, phase,
       template_set, choice_options)
    VALUES
      -- TRUST (1-4)
      ('TP3_TRUST_1', 'trust',
       'I trust our senior leaders to follow through on the commitments they make.',
       'scale', 1, 5, 'standard', 'approved', 10, 'pre', 'tp3_assessment', NULL),

      ('TP3_TRUST_2', 'trust',
       'People can raise concerns or bad news here without fear of punishment.',
       'scale', 1, 5, 'standard', 'approved', 20, 'pre', 'tp3_assessment', NULL),

      ('TP3_TRUST_3', 'trust',
       'Leaders explain the "why" behind important decisions clearly enough.',
       'scale', 1, 5, 'standard', 'approved', 30, 'pre', 'tp3_assessment', NULL),

      ('TP3_TRUST_4', 'trust',
       'Teams and departments treat each other with respect, not blame.',
       'scale', 1, 5, 'standard', 'approved', 40, 'pre', 'tp3_assessment', NULL),

      -- PROACTIVITY (5-8)
      ('TP3_PROACT_1', 'proactivity',
       'People take ownership instead of waiting to be told exactly what to do.',
       'scale', 1, 5, 'standard', 'approved', 50, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROACT_2', 'proactivity',
       'We raise issues early, before they turn into emergencies.',
       'scale', 1, 5, 'standard', 'approved', 60, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROACT_3', 'proactivity',
       'Decisions are usually made at the right level without always needing top approval.',
       'scale', 1, 5, 'standard', 'approved', 70, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROACT_4', 'proactivity',
       'When priorities change, leaders clearly reset expectations and tradeoffs.',
       'scale', 1, 5, 'standard', 'approved', 80, 'pre', 'tp3_assessment', NULL),

      -- PRODUCTIVITY / EXECUTION (9-12)
      ('TP3_PROD_1', 'productivity',
       'Our top priorities for the next 90 days are clear to me.',
       'scale', 1, 5, 'standard', 'approved', 90, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROD_2', 'productivity',
       'Most meetings lead to clear decisions, owners, and next steps.',
       'scale', 1, 5, 'standard', 'approved', 100, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROD_3', 'productivity',
       'High-value work is not constantly derailed by low-impact urgent requests.',
       'scale', 1, 5, 'standard', 'approved', 110, 'pre', 'tp3_assessment', NULL),

      ('TP3_PROD_4', 'productivity',
       'Cross-functional projects move at the speed they should in our organization.',
       'scale', 1, 5, 'standard', 'approved', 120, 'pre', 'tp3_assessment', NULL),

      -- OVERALL (13)
      ('TP3_OVERALL_1', 'overall',
       'Overall, our organization executes effectively on its most important goals.',
       'scale', 1, 5, 'standard', 'approved', 130, 'pre', 'tp3_assessment', NULL),

      -- NPS (14)
      ('TP3_NPS_1', 'nps',
       'How likely are you to recommend this organization as a great place to work? (0–10)',
       'numeric', 0, 10, 'standard', 'approved', 140, 'pre', 'tp3_assessment', NULL),

      -- QUALITATIVE — START/STOP/CONTINUE/ADVICE (15-18)
      ('TP3_QUAL_START', 'qualitative',
       'START: What is one thing we should START doing to increase trust, proactivity, or productivity in this organization over the next 6–12 months?',
       'text', NULL, NULL, 'standard', 'approved', 150, 'pre', 'tp3_assessment', NULL),

      ('TP3_QUAL_STOP', 'qualitative',
       'STOP: What is one thing we should STOP doing because it reduces trust, proactivity, or productivity?',
       'text', NULL, NULL, 'standard', 'approved', 160, 'pre', 'tp3_assessment', NULL),

      ('TP3_QUAL_CONT', 'qualitative',
       'CONTINUE: What is one thing we should CONTINUE or double down on because it already builds trust, proactivity, or productivity here?',
       'text', NULL, NULL, 'standard', 'approved', 170, 'pre', 'tp3_assessment', NULL),

      ('TP3_QUAL_ADVICE', 'qualitative',
       'ADVICE TO LEADERS: If you could give senior leaders one piece of advice to improve how we work together, what would it be?',
       'text', NULL, NULL, 'standard', 'approved', 180, 'pre', 'tp3_assessment', NULL),

      -- BOTTLENECK & CONSEQUENCE SPINE (19-21)
      ('TP3_BOTTLENECK_1', 'bottleneck',
       'Of the three areas below, which is currently the biggest bottleneck in your part of the organization? (Pick one.)',
       'choice', NULL, NULL, 'standard', 'approved', 190, 'pre', 'tp3_assessment',
       '["Trust (how much we can rely on each other and our leaders)","Proactivity (ownership, raising issues early, taking initiative)","Productivity (clarity, meetings, and how fast work actually moves)","They''re roughly equal","I''m not sure"]'::jsonb),

      ('TP3_BOTTLENECK_WHY', 'bottleneck',
       'In a sentence or two, what makes you say that is the biggest bottleneck right now? Please give a recent example if you can.',
       'text', NULL, NULL, 'standard', 'approved', 200, 'pre', 'tp3_assessment', NULL),

      ('TP3_COST_1', 'consequence',
       'If we do NOT improve how we work together over the next 12–24 months, what do you think the biggest risk or cost will be for the organization (for customers, revenue, safety, or people)?',
       'text', NULL, NULL, 'standard', 'approved', 210, 'pre', 'tp3_assessment', NULL);

  END IF;
END $$;

-- ── 3. Demographic question templates (coach-toggleable) ─────
-- These are NOT inserted with the base 21 — coach enables per assessment.
-- They live as global templates and are copied on demand.
-- Seeded here for reference / future use.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workshop_questions
    WHERE workshop_id IS NULL AND template_set = 'tp3_assessment'
      AND is_demographic = TRUE
  ) THEN

    INSERT INTO workshop_questions
      (question_id, question_theme, question_text, response_type,
       scale_min, scale_max, source, status, sort_order, phase,
       template_set, is_demographic, demographic_key)
    VALUES
      ('TP3_DEMO_NAME',    'demographic', 'Your name',         'text', NULL, NULL, 'standard', 'approved', 5,   'pre', 'tp3_assessment', TRUE, 'name'),
      ('TP3_DEMO_EMAIL',   'demographic', 'Your email address','text', NULL, NULL, 'standard', 'approved', 6,   'pre', 'tp3_assessment', TRUE, 'email'),
      ('TP3_DEMO_TITLE',   'demographic', 'Your job title',    'text', NULL, NULL, 'standard', 'approved', 7,   'pre', 'tp3_assessment', TRUE, 'job_title'),
      ('TP3_DEMO_DEPT',    'demographic', 'Department / function', 'text', NULL, NULL, 'standard', 'approved', 8, 'pre', 'tp3_assessment', TRUE, 'department'),
      ('TP3_DEMO_LOC',     'demographic', 'Primary location / site', 'text', NULL, NULL, 'standard', 'approved', 9, 'pre', 'tp3_assessment', TRUE, 'location'),
      ('TP3_DEMO_LEVEL',   'demographic', 'Management level',  'choice', NULL, NULL, 'standard', 'approved', 10, 'pre', 'tp3_assessment', TRUE, 'mgmt_level'),
      ('TP3_DEMO_TENURE',  'demographic', 'Tenure at organization', 'choice', NULL, NULL, 'standard', 'approved', 11, 'pre', 'tp3_assessment', TRUE, 'tenure'),
      ('TP3_DEMO_MANAGER', 'demographic', 'Are you a people manager?', 'choice', NULL, NULL, 'standard', 'approved', 12, 'pre', 'tp3_assessment', TRUE, 'is_manager');

  END IF;
END $$;
