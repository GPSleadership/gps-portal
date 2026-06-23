-- v64: Coach-authored narrative for the leader "Your Results" page.
-- Additive only. Lives on diagnostics (one per leader) so it survives report-draft
-- regeneration. Numbers always come from the latest report draft's scores_json;
-- these are the WORDS the coach writes (headline, honest read, the two real quotes).
-- Old code ignores the column; new code reads it when present.

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS results_narrative jsonb;

COMMENT ON COLUMN diagnostics.results_narrative IS
  'Coach-authored copy for the leader visual results page. Shape: '
  '{ "headline": text, "honest_read": text, '
  '"supervisor_quote": text, "team_quote": text, "updated_at": timestamptz }. '
  'Numbers are never stored here — they come from diagnostic_report_drafts.scores_json.';

-- diagnostics already has RLS enabled with no anon policies (service-role only,
-- matching the rest of the schema). No policy change required: the column is read
-- and written exclusively through the session/token-validated serverless endpoints.

-- ============================================================================
-- ROLLBACK
-- ALTER TABLE diagnostics DROP COLUMN IF EXISTS results_narrative;
-- ============================================================================
