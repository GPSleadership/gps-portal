-- GPS Leadership Solutions — Supabase Migration v15
-- Adds coaching_notes and interview_notes to the diagnostics table.
-- These fields are used in the coach portal Overview tab (Coach Notes section)
-- and are included in the Claude report generation prompt.
--
-- Run this in the Supabase SQL Editor.

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS coaching_notes  TEXT,
  ADD COLUMN IF NOT EXISTS interview_notes TEXT;

COMMENT ON COLUMN diagnostics.coaching_notes  IS 'Ongoing coaching observations and session notes entered by Alex in the coach portal. Included in report generation.';
COMMENT ON COLUMN diagnostics.interview_notes IS 'Notes from 1:1 interviews with raters or stakeholders, entered by Alex. Included in report generation.';
