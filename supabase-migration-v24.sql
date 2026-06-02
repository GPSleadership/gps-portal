-- Migration v24: Debrief date + report auto-release
-- Adds debrief_date and report_release_at to diagnostics table.
-- report_release_at = 22:00 UTC the day before debrief_date
-- (= 6pm EDT / 5pm EST = "COB Eastern")
-- Computed and stored by coach portal when debrief_date is saved.

ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS debrief_date date;
ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS report_release_at timestamptz;
