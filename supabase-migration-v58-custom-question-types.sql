-- ════════════════════════════════════════════════════════════════════════════
-- v58: custom question types — diagnostics (2026-06-12)
-- Additive only. The two coach-entered custom questions (G2 "Custom 1",
-- G3 "Custom 2") can now each be 'scale' (rated 1-5, current behavior and
-- the default) or 'open' (written answer). The survey page renders the open
-- type as a textarea; the report collects open answers as verbatims.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostics
  add column if not exists custom_g2_type text not null default 'scale';

alter table diagnostics
  add column if not exists custom_g3_type text not null default 'scale';

-- ROLLBACK
-- alter table diagnostics drop column if exists custom_g2_type;
-- alter table diagnostics drop column if exists custom_g3_type;
