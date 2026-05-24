-- ============================================================
-- GPS Leadership Solutions — Migration v14
-- Diagnostic Email Templates
--
-- Run in Supabase SQL Editor after v13.
-- Safe to re-run: uses INSERT ... ON CONFLICT DO UPDATE.
--
-- Adds 6 email templates to email_templates for the
-- 14-Day Executive Leadership Diagnostic workflow:
--
--   diagnostic_invite      — Initial rater invite
--   diagnostic_reminder_1  — Day+2 nudge to incomplete raters
--   diagnostic_reminder_2  — Day+5 final reminder to incomplete raters
--   diagnostic_t2_alert    — T-2 low-response alert to coach
--   diagnostic_report_ready — Report is finalized (to coach)
--   diagnostic_plan_locked  — 90-day plan auto-locked (to coach)
--
-- Template variables use {{double_brace}} notation.
-- ============================================================


-- ── Add is_diagnostic flag to email_templates ───────────────────────────────
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS is_diagnostic BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN email_templates.is_diagnostic IS
  'TRUE for templates used by the 14-Day Diagnostic workflow.
   FALSE for coaching engagement templates (default).';


-- ── Insert / upsert diagnostic email templates ──────────────────────────────
-- Columns: template_key, label, subject, body_text, is_approved, is_diagnostic

INSERT INTO email_templates (template_key, label, subject, body_text, is_approved, is_diagnostic)
VALUES

-- ── 1. Initial rater invite ─────────────────────────────────────────────────
(
  'diagnostic_invite',
  'Diagnostic — Rater Invite',
  'Your input is requested — {{leader_name}} leadership feedback',
  'Hi {{rater_first_name}},

I''m asking for your honest feedback as part of a leadership development process for {{leader_name}}{{leader_title_org}}.

This is a short survey — most people complete it in 5–8 minutes. Your responses help build a clear, honest picture of leadership strengths and development areas.

A few things to know:
- Your responses are confidential — individual answers are never shared with the leader.
- Please complete it by {{close_date}}.
- Honest, specific feedback is the most useful.

Complete the survey here: {{survey_link}}

Thank you for taking the time — this feedback genuinely matters.

– Alex Tremble
GPS Leadership Solutions',
  TRUE,
  TRUE
),

-- ── 2. Rater reminder 1 (day +2) ───────────────────────────────────────────
(
  'diagnostic_reminder_1',
  'Diagnostic — Rater Reminder 1 (Day +2)',
  'Quick reminder — {{leader_name}} leadership feedback',
  'Hi {{rater_first_name}},

A quick follow-up — you haven''t yet completed the feedback survey for {{leader_name}}.

The survey closes on {{close_date}} — there''s still time.

It takes 5–8 minutes. Your responses are confidential — individual answers are never shared.

Complete the survey here: {{survey_link}}

– Alex Tremble
GPS Leadership Solutions',
  TRUE,
  TRUE
),

-- ── 3. Rater reminder 2 (day +5, final) ────────────────────────────────────
(
  'diagnostic_reminder_2',
  'Diagnostic — Rater Reminder 2 (Day +5, Final)',
  'Last reminder — {{leader_name}} leadership feedback',
  'Hi {{rater_first_name}},

This is your last reminder for the {{leader_name}} leadership feedback survey.

The survey closes {{close_date}}. After that, it will no longer be available.

Complete the survey here: {{survey_link}}

If you''ve already submitted your responses, please disregard this message.

– Alex Tremble
GPS Leadership Solutions',
  TRUE,
  TRUE
),

-- ── 4. T-2 low-response alert to coach ─────────────────────────────────────
(
  'diagnostic_t2_alert',
  'Diagnostic — T-2 Low Response Alert (to Coach)',
  'T-2 Alert — {{leader_name}} diagnostic ({{completed_count}}/{{total_invited}} complete)',
  'Alex,

This is an automated T-2 alert for the {{leader_name}} diagnostic.

Survey closes: {{close_date}}
Completions: {{completed_count}} of {{total_invited}} raters
Minimum recommended: 7

You may want to reach out directly to incomplete raters or extend the close date in the coach portal.

– GPS Leadership Portal (automated)',
  TRUE,
  TRUE
),

-- ── 5. Report ready notification to coach ──────────────────────────────────
(
  'diagnostic_report_ready',
  'Diagnostic — Report Ready (to Coach)',
  'Report ready for review — {{leader_name}}',
  'Alex,

The diagnostic report for {{leader_name}} has been generated and is ready for your review.

Open the coach portal to review, edit, and finalize the report before the debrief.

– GPS Leadership Portal (automated)',
  TRUE,
  TRUE
),

-- ── 6. 90-day plan auto-locked notification to coach ───────────────────────
(
  'diagnostic_plan_locked',
  'Diagnostic — 90-Day Plan Auto-Locked (to Coach)',
  '90-Day Plan auto-locked — {{leader_name}}',
  'Alex,

The 90-day plan for {{leader_name}} has been automatically locked.

Lock date: {{locked_at}}

The plan was locked 24 hours after the debrief was marked complete. To unlock it manually, open the diagnostic in the coach portal.

– GPS Leadership Portal (automated)',
  TRUE,
  TRUE
)

ON CONFLICT (template_key)
DO UPDATE SET
  label        = EXCLUDED.label,
  subject      = EXCLUDED.subject,
  body_text    = EXCLUDED.body_text,
  is_approved  = EXCLUDED.is_approved,
  is_diagnostic= EXCLUDED.is_diagnostic,
  updated_at   = now();


-- ── Confirm ─────────────────────────────────────────────────────────────────
SELECT template_key, label, is_diagnostic, is_approved
FROM   email_templates
WHERE  is_diagnostic = TRUE
ORDER  BY template_key;
