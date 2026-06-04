-- ============================================================================
-- GPS Leadership Portal — Migration v31: TEAM REPORT BRANDED-PDF
-- ============================================================================
--
--  The written team report now follows the same model as the individual report:
--  the system generates a DRAFT (content_text, coach-only), the coach polishes it
--  into a branded PDF externally and uploads it, and the SPONSOR sees the uploaded
--  PDF, not the raw generated text.
--
--    • report_pdf_url — the coach-uploaded branded PDF. The sponsor endpoint
--      returns this (never content_text) and only when sponsor_visible is true.
--
--  Additive and safe: existing rows get NULL (no PDF yet); content_text stays as
--  the coach draft. RLS posture inherited (deny-all to anon post-v26).
-- ============================================================================

BEGIN;

ALTER TABLE diagnostic_team_reports
  ADD COLUMN IF NOT EXISTS report_pdf_url TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE diagnostic_team_reports DROP COLUMN IF EXISTS report_pdf_url;
-- COMMIT;
-- ============================================================================
