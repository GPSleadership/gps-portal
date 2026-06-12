-- ════════════════════════════════════════════════════════════════════════════
-- v55: anonymous feedback toggle — diagnostics (client request, 2026-06-12)
-- Additive only.
--
-- Hard-cut model: when diagnostics.anonymous_feedback is true, rater
-- submissions store rater_id = NULL with a rater_relationship snapshot, so
-- responses are permanently unlinkable from people. Names/emails stay on
-- diagnostic_raters for delivery (invites, reminders, completion tracking).
-- The leader's self-assessment always stays linked (it is their own data).
--
-- Existing diagnostics are backfilled to FALSE (current behavior preserved
-- mid-engagement); the column default is then set to TRUE so new diagnostics
-- start anonymous.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostics
  add column if not exists anonymous_feedback boolean not null default false;

alter table diagnostics
  alter column anonymous_feedback set default true;

alter table diagnostic_responses
  add column if not exists rater_relationship text;

-- ROLLBACK
-- alter table diagnostics drop column if exists anonymous_feedback;
-- alter table diagnostic_responses drop column if exists rater_relationship;
