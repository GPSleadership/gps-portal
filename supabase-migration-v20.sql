-- ============================================================
-- GPS Leadership Portal — Migration v20
-- New Onboarding Wizard: Metric 2 + Diagnostic Prefill Support
--
-- Run BEFORE deploying updated client.html and get-client.js.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
--
-- Changes:
--   1. clients.metric_2_question    — stakeholder perception question (new Metric 2 model)
--   2. clients.metric_2_target_avg  — target average score (default 4.0 on 1–5 scale)
--   3. diagnostics.wizard_prefill_data — structured JSON for onboarding wizard prefill
--                                        set by coach after debrief, consumed by get-client.js
-- ============================================================

-- ── 1. clients — new Metric 2 model ─────────────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS metric_2_question TEXT;

COMMENT ON COLUMN clients.metric_2_question IS
  'Stakeholder perception question for Metric 2 (new wizard model).
   Non-null = client used new onboarding wizard (1-5 agreement scale).
   Null = legacy free-form metric model (check metric_2_name instead).';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS metric_2_target_avg FLOAT DEFAULT 4.0;

COMMENT ON COLUMN clients.metric_2_target_avg IS
  'Target average score for Metric 2 stakeholder perception survey (1-5 scale).
   Default 4.0. Only meaningful when metric_2_question IS NOT NULL.';

-- ── 2. diagnostics — wizard prefill data ────────────────────────────────────
-- Set by coach after debrief. Consumed by get-client.js on first portal load.
-- Structure: { key_theme, suggested: { goal90, goal30, behavior1, behavior2, metric1, metric2, stakeholders }, scores: { Trust, Proactivity, Productivity } }
-- NULL = no prefill; wizard runs with blank fields.
ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS wizard_prefill_data JSONB;

COMMENT ON COLUMN diagnostics.wizard_prefill_data IS
  'Structured JSON for onboarding wizard prefill. Set by coach after debrief.
   NULL = no prefill data available; wizard runs with blank fields.';

-- Fast lookup for get-client.js portal load query
CREATE INDEX IF NOT EXISTS idx_diagnostics_wizard_prefill
  ON diagnostics (client_id)
  WHERE wizard_prefill_data IS NOT NULL;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Run this SELECT after the migration to confirm all 3 columns exist:
SELECT
  table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('clients','diagnostics')
  AND column_name IN ('metric_2_question','metric_2_target_avg','wizard_prefill_data')
ORDER BY table_name, column_name;
