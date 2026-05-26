-- GPS Leadership Solutions — Supabase Migration v16
-- Creates the diagnostic_team_reports table for storing AI-generated
-- composite leadership team reports.
--
-- Run this in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS diagnostic_team_reports (
  id                    UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  org_name              TEXT,
  team_name             TEXT,
  prepared_for_name     TEXT,
  prepared_for_title    TEXT,
  assessment_date_range TEXT,
  sector_type           TEXT         DEFAULT 'private',
  diagnostic_ids        JSONB,       -- array of diagnostic UUIDs included
  num_leaders           INTEGER,
  total_raters          INTEGER,
  content_text          TEXT,        -- full draft report as plain text / markdown
  generated_at          TIMESTAMPTZ  DEFAULT now(),
  created_at            TIMESTAMPTZ  DEFAULT now(),
  updated_at            TIMESTAMPTZ  DEFAULT now()
);

COMMENT ON TABLE  diagnostic_team_reports IS 'AI-generated composite team diagnostic report drafts for internal consultant review.';
COMMENT ON COLUMN diagnostic_team_reports.diagnostic_ids IS 'JSON array of diagnostic UUIDs that were included in this team report.';
COMMENT ON COLUMN diagnostic_team_reports.content_text   IS 'Full report body as plain text with markdown-style section headers. DRAFT only — for consultant review before client distribution.';

-- Enable RLS (anon key read-only; service role for writes via API)
ALTER TABLE diagnostic_team_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read" ON diagnostic_team_reports
  FOR SELECT USING (true);

CREATE POLICY "Allow anon insert" ON diagnostic_team_reports
  FOR INSERT WITH CHECK (true);
