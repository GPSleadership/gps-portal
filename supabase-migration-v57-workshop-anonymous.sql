-- ════════════════════════════════════════════════════════════════════════════
-- v57: anonymous feedback toggle — workshops / org assessments (2026-06-12)
-- Additive only. Same hard-cut model as diagnostics (v55):
-- when workshops.anonymous_feedback is true, FINAL participant submissions
-- store participant_id = NULL (the in-room QR path already does this and all
-- aggregation handles it). Drafts stay linked so save/resume keeps working;
-- the link is severed at submission. Completion tracking and reminders use
-- workshop_participants.pre/post_status, unaffected.
-- Existing engagements backfilled to FALSE; new ones default TRUE.
-- ════════════════════════════════════════════════════════════════════════════

alter table workshops
  add column if not exists anonymous_feedback boolean not null default false;

alter table workshops
  alter column anonymous_feedback set default true;

-- ROLLBACK
-- alter table workshops drop column if exists anonymous_feedback;
