-- GPS Leadership Portal — Migration v20
-- Adds G2 custom question columns to diagnostics table.
-- G2 is an AI-generated behavioral survey question drawn from the leader's full
-- self-assessment, designed to subtly surface a gap that GPS coaching addresses.
--
-- Run in Supabase SQL editor: Project → SQL Editor → Paste → Run

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS custom_g2_question       TEXT,
  ADD COLUMN IF NOT EXISTS custom_g2_generated_at   TIMESTAMPTZ;

COMMENT ON COLUMN diagnostics.custom_g2_question IS
  'AI-generated behavioral question (G2) shown to raters — probes a GPS-relevant leadership gap inferred from the leader''s self-assessment.';

COMMENT ON COLUMN diagnostics.custom_g2_generated_at IS
  'Timestamp when custom_g2_question was last generated.';
