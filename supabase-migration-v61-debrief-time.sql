-- ════════════════════════════════════════════════════════════════════════════
-- v61: debrief time (2026-06-14)
-- Additive only. debrief_date already exists (date). This adds a free-text time
-- so the pre-debrief email (FR-003) can state both the date AND time of the
-- debrief session (e.g., "2:00 PM ET"). Free text keeps timezone flexible.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostics add column if not exists debrief_time text;

-- ROLLBACK
-- alter table diagnostics drop column if exists debrief_time;
