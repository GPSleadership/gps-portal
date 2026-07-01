-- Migration v77: add 'reschedule' message type to coach_messages
-- Additive only. Widens the CHECK constraint; existing rows are unaffected.
-- Applied: <date>

-- ROLLBACK:
-- ALTER TABLE coach_messages DROP CONSTRAINT IF EXISTS coach_messages_message_type_check;
-- ALTER TABLE coach_messages ADD CONSTRAINT coach_messages_message_type_check
--   CHECK (message_type = ANY(ARRAY[
--     'quick_question','prep_for_session','progress_update','win','logistics'
--   ]));

ALTER TABLE coach_messages
  DROP CONSTRAINT IF EXISTS coach_messages_message_type_check;

ALTER TABLE coach_messages
  ADD CONSTRAINT coach_messages_message_type_check
  CHECK (message_type = ANY(ARRAY[
    'quick_question',
    'prep_for_session',
    'progress_update',
    'win',
    'logistics',
    'reschedule'
  ]));
