-- v108 — anonymous segmentation for Ask Alex theme reporting
--
-- Ask Alex conversations are NOT reviewed for coaching prep and are no longer shown
-- per-client in the coach console. They are retained only to improve the tool and are
-- reviewed in aggregate. These denormalized segment columns are captured at write time
-- so theme reports can slice by industry / title / size WITHOUT joining back to clients.
--
-- client_id intentionally REMAINS on ask_alex_log: required for the 20/day rate limit
-- in api/ask.js. Anonymity is enforced by what the reports select and by the console
-- no longer rendering transcripts.
--
-- NOTE: already applied to production 2026-07-19 under the label v107_ask_alex_anon_segments
-- (renumbered to v108 here because v107 was taken by legal-texts-consent). Idempotent.

ALTER TABLE ask_alex_log
  ADD COLUMN IF NOT EXISTS segment_industry      text,
  ADD COLUMN IF NOT EXISTS segment_title         text,
  ADD COLUMN IF NOT EXISTS segment_revenue_band  text;

-- ROLLBACK:
-- ALTER TABLE ask_alex_log
--   DROP COLUMN IF EXISTS segment_industry,
--   DROP COLUMN IF EXISTS segment_title,
--   DROP COLUMN IF EXISTS segment_revenue_band;
