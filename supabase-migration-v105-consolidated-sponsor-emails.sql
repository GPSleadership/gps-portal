-- v105: Consolidated sponsor emails
-- Goal: a sponsor with several leaders gets ONE pre-debrief email listing all of them
-- and their debrief dates, instead of one email per leader. Sponsor-level email rows
-- carry sponsor_id and leave diagnostic_id NULL (they belong to the sponsor, not one
-- leader). A partial unique index guarantees a single consolidated row per (sponsor,
-- email_key), so re-running the builder upserts rather than duplicating.
--
-- Safe/additive: new nullable columns + indexes only. No existing row is modified.

ALTER TABLE public.email_drafts
  ADD COLUMN IF NOT EXISTS sponsor_id uuid REFERENCES public.sponsors(id) ON DELETE CASCADE;

-- Snapshot of who was on the roster when the email was built (audit + render fallback).
ALTER TABLE public.email_drafts
  ADD COLUMN IF NOT EXISTS roster jsonb;

-- Sponsor-level consolidated rows are not tied to a single diagnostic.
ALTER TABLE public.email_drafts ALTER COLUMN diagnostic_id DROP NOT NULL;

-- One consolidated row per sponsor per key (only for sponsor-level rows).
CREATE UNIQUE INDEX IF NOT EXISTS email_drafts_sponsor_key_uq
  ON public.email_drafts (sponsor_id, email_key)
  WHERE sponsor_id IS NOT NULL AND diagnostic_id IS NULL;

CREATE INDEX IF NOT EXISTS email_drafts_sponsor_id_idx
  ON public.email_drafts (sponsor_id) WHERE sponsor_id IS NOT NULL;
