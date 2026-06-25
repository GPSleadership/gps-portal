-- v73: per-sponsor debrief date. Applied to prod 2026-06-25.
-- The sponsor's full Decision Room auto-reveals the day before this date; the
-- manual confidentiality_mode toggle overrides. NULL = manual control only.
ALTER TABLE sponsor_teams ADD COLUMN IF NOT EXISTS sponsor_debrief_date date;
COMMENT ON COLUMN sponsor_teams.sponsor_debrief_date IS
  'Sponsor''s own debrief date. Full Decision Room auto-reveals the day before; manual confidentiality_mode toggle overrides. NULL = manual control only.';
