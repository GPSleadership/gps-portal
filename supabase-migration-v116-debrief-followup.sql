-- v116: debrief follow-up email — sent-log columns on debrief_captures + AI flag
--
-- Adds a light send-log to the existing debrief_captures row so we know when a
-- follow-up went out, to whom, and with what subject (idempotency + audit trail).
-- Also registers the AI feature flag so the follow-up drafter shows up in
-- coach Settings -> AI Controls and can be killed like every other AI feature
-- (missing/enabled row = ON, fail-open; enabled=false falls back to a template).
--
-- Additive only. debrief_captures already exists (v115), RLS deny-all, served
-- only through the coach-gated endpoints. No anon exposure.

alter table public.debrief_captures
  add column if not exists followup_sent_at  timestamptz,
  add column if not exists followup_to       text,
  add column if not exists followup_subject  text;

insert into public.ai_feature_flags (feature, enabled, label) values
  ('debrief_followup', true, 'Debrief follow-up email drafts')
on conflict (feature) do nothing;

-- ROLLBACK
-- alter table public.debrief_captures
--   drop column if exists followup_sent_at,
--   drop column if exists followup_to,
--   drop column if exists followup_subject;
-- delete from public.ai_feature_flags where feature = 'debrief_followup';
