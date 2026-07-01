-- Migration v80: metric-aware check-in + commitment + streak columns
-- GPS Leadership Solutions
-- Adds structured metric config, commitment tracking, streak caching, and at-risk flag.
-- All columns use IF NOT EXISTS — safe to run if any already exist.

-- ── clients table additions ────────────────────────────────────────────────

-- Structured metric config (Feature 1)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metric_1_statement  text;         -- Full-sentence metric goal ("Increase on-time delivery from 72% to 90%")
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metric_1_unit       text;         -- Unit label ("%", "dispatches/week", "count")
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metric_1_type       text;         -- "number" | "percentage" | "ratio"
ALTER TABLE clients ADD COLUMN IF NOT EXISTS metric_1_ratio_denom text;        -- Denominator for ratio metrics

-- Commitment + reminders (Feature 3 / Feature 5)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS checkin_day         text;         -- Day of week for reminders: "monday" … "sunday"
ALTER TABLE clients ADD COLUMN IF NOT EXISTS commitment_accepted_at timestamptz; -- Null = commitment modal not yet shown/accepted

-- Streak + at-risk (Feature 4 / Feature 5)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS current_checkin_streak int NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS at_risk              boolean NOT NULL DEFAULT false;

-- ── Comments ──────────────────────────────────────────────────────────────
COMMENT ON COLUMN clients.metric_1_statement     IS 'Coach-authored full-sentence metric goal shown to client in wizard.';
COMMENT ON COLUMN clients.metric_1_unit          IS 'Unit label rendered next to metric inputs (%, count, /week, etc.).';
COMMENT ON COLUMN clients.metric_1_type          IS 'Metric input type: number | percentage | ratio. Controls check-in UI.';
COMMENT ON COLUMN clients.metric_1_ratio_denom   IS 'Ratio denominator label (e.g. "total deliveries"). Null for non-ratio types.';
COMMENT ON COLUMN clients.checkin_day            IS 'Day of week the client committed to check in. Drives smart reminder timing.';
COMMENT ON COLUMN clients.commitment_accepted_at IS 'Timestamp when client accepted the 90-day commitment modal. Null = not yet shown.';
COMMENT ON COLUMN clients.current_checkin_streak IS 'Cached count of consecutive weekly check-ins. Updated server-side on each submit.';
COMMENT ON COLUMN clients.at_risk                IS 'True when client missed two or more consecutive check-ins. Triggers coach alert.';

-- ROLLBACK:
-- ALTER TABLE clients DROP COLUMN IF EXISTS metric_1_statement;
-- ALTER TABLE clients DROP COLUMN IF EXISTS metric_1_unit;
-- ALTER TABLE clients DROP COLUMN IF EXISTS metric_1_type;
-- ALTER TABLE clients DROP COLUMN IF EXISTS metric_1_ratio_denom;
-- ALTER TABLE clients DROP COLUMN IF EXISTS checkin_day;
-- ALTER TABLE clients DROP COLUMN IF EXISTS commitment_accepted_at;
-- ALTER TABLE clients DROP COLUMN IF EXISTS current_checkin_streak;
-- ALTER TABLE clients DROP COLUMN IF EXISTS at_risk;
