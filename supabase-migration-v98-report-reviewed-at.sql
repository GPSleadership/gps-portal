-- v98 — report_reviewed_at: the hard gate for the gated report flow.
--
-- The redesigned report card is a sequential flow: Generate -> Draft plan ->
-- Review -> Publish. Publish is impossible until the coach has reviewed the
-- rendered leader page. "Reviewed" is a deliberate confirm that stamps this
-- column. The publish gate requires report_reviewed_at > report_generated_at,
-- so REGENERATING a draft (which bumps report_generated_at) makes the prior
-- review stale and re-locks publish. This closes the bug where generating a new
-- draft silently un-finalized a finalized report.
--
-- Additive. Old code ignores the new column.

alter table diagnostics add column if not exists report_reviewed_at timestamptz;

comment on column diagnostics.report_reviewed_at is
  'When the coach reviewed the rendered leader page. Publish gate requires report_reviewed_at > report_generated_at, so regenerating invalidates the review and re-locks publish.';

-- ROLLBACK
-- alter table diagnostics drop column if exists report_reviewed_at;
