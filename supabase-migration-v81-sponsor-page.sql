-- ============================================================================
-- GPS Leadership Portal — Migration v81: SPONSOR FOLLOW-ALONG PAGE
-- ============================================================================
--
--  Roadmap #4 (Sponsor page). Adds the coach-authored content and the
--  page-specific confidentiality control to the single-leader coaching
--  sponsor row (public.sponsors, linked_client_id set by the Activate flow).
--
--    coach_summary            — the coach's short "From your coach" note shown
--                               on the sponsor page (coach-authored only).
--    coach_summary_updated_at — when the coach last saved the summary.
--    sponsor_actions          — the coach-authored "How you can help" note
--                               (1-2 concrete sponsor actions).
--    confidentiality_mode     — sponsor-page view mode:
--                                 'summary'       (default) — full follow-along
--                                 'outcomes_only' — trend + coach summary only
--                               (This is separate from the legacy
--                                confidentiality_default standard|private used
--                                by the team Decision Room, which is untouched.)
--
--  Additive and safe. Old code ignores the new columns. RLS deny-all to anon
--  (post-v26); all access via the service-role /api/sponsor endpoint, which
--  hand-scopes the payload (the confidentiality wall lives in the endpoint,
--  never client-side and never on RLS).
-- ============================================================================

BEGIN;

ALTER TABLE public.sponsors
  ADD COLUMN IF NOT EXISTS coach_summary            TEXT,
  ADD COLUMN IF NOT EXISTS coach_summary_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sponsor_actions          TEXT,
  ADD COLUMN IF NOT EXISTS confidentiality_mode     TEXT NOT NULL DEFAULT 'summary';

-- Constrain the new mode to the two supported values. Guarded so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sponsors_confidentiality_mode_chk'
  ) THEN
    ALTER TABLE public.sponsors
      ADD CONSTRAINT sponsors_confidentiality_mode_chk
      CHECK (confidentiality_mode IN ('summary', 'outcomes_only'));
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE public.sponsors DROP CONSTRAINT IF EXISTS sponsors_confidentiality_mode_chk;
--   ALTER TABLE public.sponsors DROP COLUMN IF EXISTS confidentiality_mode;
--   ALTER TABLE public.sponsors DROP COLUMN IF EXISTS sponsor_actions;
--   ALTER TABLE public.sponsors DROP COLUMN IF EXISTS coach_summary_updated_at;
--   ALTER TABLE public.sponsors DROP COLUMN IF EXISTS coach_summary;
-- COMMIT;
-- ============================================================================
