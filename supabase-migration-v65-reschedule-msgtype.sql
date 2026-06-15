-- ════════════════════════════════════════════════════════════════════════════
-- v65: allow 'reschedule' coach message type  ⚠️ NOT YET APPLIED — hold until Alex approves.
-- The v62 CHECK constraint on coach_messages.message_type does not include
-- 'reschedule', so inserting a reschedule request would fail until this runs.
-- Drops and re-adds the constraint with the new value included. Additive in
-- effect (only widens the allowed set); existing rows are unaffected.
-- ════════════════════════════════════════════════════════════════════════════

alter table coach_messages drop constraint if exists coach_messages_message_type_check;
alter table coach_messages add constraint coach_messages_message_type_check
  check (message_type in ('quick_question', 'prep_for_session', 'progress_update', 'win', 'reschedule', 'logistics'));

-- ROLLBACK (restores the v62 allowed set; only safe if no 'reschedule' rows exist)
-- alter table coach_messages drop constraint if exists coach_messages_message_type_check;
-- alter table coach_messages add constraint coach_messages_message_type_check
--   check (message_type in ('quick_question', 'prep_for_session', 'progress_update', 'win', 'logistics'));
