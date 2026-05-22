-- GPS Leadership — Supabase Migration v5
-- Adds draft/confirmed state to the stakeholders table.
--
-- New columns:
--   confirmed_at  TIMESTAMPTZ  NULL means draft, non-null means confirmed
--   added_by      TEXT         'coach' (default) or 'client'
--
-- Run this in the Supabase SQL editor.

-- ─── 1. Add new columns ──────────────────────────────────────────────────────

ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS added_by     TEXT DEFAULT 'coach';

-- ─── 2. Backfill existing rows — all coach-added stakeholders are confirmed ──

UPDATE stakeholders
SET
  confirmed_at = created_at,
  added_by     = 'coach'
WHERE confirmed_at IS NULL;

-- ─── 3. Index for fast draft queries (daily cron auto-confirm) ───────────────

CREATE INDEX IF NOT EXISTS idx_stakeholders_confirmed_at
  ON stakeholders (confirmed_at)
  WHERE confirmed_at IS NULL;
