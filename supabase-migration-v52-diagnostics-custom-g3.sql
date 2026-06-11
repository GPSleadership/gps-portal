-- Migration v52: third custom diagnostic question slot. Applied to prod 2026-06-11. Additive.
-- G1 stays the AI Vision Alignment question. G2 + G3 are the coach's two manually-entered
-- custom questions (agreed with the leader at kickoff). Survey + report render all three.

ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS custom_g3_question text;
ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS custom_g3_generated_at timestamptz;

-- ROLLBACK:
-- ALTER TABLE diagnostics DROP COLUMN IF EXISTS custom_g3_question, DROP COLUMN IF EXISTS custom_g3_generated_at;
