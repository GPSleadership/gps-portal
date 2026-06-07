-- ============================================================
-- GPS Leadership Portal — Migration v40
-- Organizations table + workshop V2 columns
-- Branch: tp3-assessment-v2
-- Applied: before deploying TP3 Assessment V2 features
-- ============================================================
--
-- SECURITY: RLS enabled, no anon policies — service-role only.
-- ADDITIVE ONLY: existing code ignores new columns/tables.
-- ============================================================

-- ── 1. Organizations table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  industry    TEXT,
  size_band   TEXT,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  logo_url    TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
-- No anon RLS policies — deny-all for anon; service-role bypasses RLS.

-- Fast lookup by name for typeahead
CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations (name);

-- ── 2. Add V2 columns to workshops ──────────────────────────
-- Link to organization (nullable — existing rows get NULL)
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- Demo flag — enables "Generate sample data" button (coach-only)
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Archive flag — hides from active list without deleting
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Discovery attachment stored in org-assets Storage bucket
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS discovery_attachment_url TEXT;

-- AI-drafted recap email body (coach edits before sending)
ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS recap_email_draft TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_workshops_organization_id ON workshops (organization_id);
CREATE INDEX IF NOT EXISTS idx_workshops_is_archived      ON workshops (is_archived);

-- ── 3. Supabase Storage bucket: org-assets ──────────────────
-- Run this manually in the Supabase dashboard (Storage → New bucket)
-- OR uncomment and run via SQL if using service-role Storage API:
--
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('org-assets', 'org-assets', true)
-- ON CONFLICT (id) DO NOTHING;
--
-- Policy: allow service-role to insert/update (handled server-side).
-- Public read = true so logo URLs work in <img> tags without auth.
--
-- NOTE: Create the bucket manually in dashboard if this SQL is
--       being applied via apply_migration (it may lack storage access).
