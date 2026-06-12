-- ════════════════════════════════════════════════════════════════════════════
-- v56: drop the stale rater-relationship CHECK constraint (2026-06-12)
--
-- The constraint allowed an old taxonomy (Supervisor, Board / Investor,
-- Internal Partner, External Partner, Key Customer) while the leader page,
-- the coach bulk import, and the Excel template all send the current one
-- (Supervisor / Manager, Board Member, Internal/External Customer, Owner,
-- Skip-Level Report, External Stakeholder, free-text Other). Result: every
-- add except Direct Report / Peer failed — verified live on the Wayside
-- diagnostic (Sergio Sabido's "Other" and "Supervisor" errors).
--
-- The taxonomy now lives in the UI + template; report bucketing normalizes
-- values in api/diagnostic.js (normalizeRel). A free-text "Other" is valid.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostic_raters drop constraint if exists diagnostic_raters_relationship_check;

-- ROLLBACK
-- alter table diagnostic_raters add constraint diagnostic_raters_relationship_check
--   check (relationship = any (array['Self','Direct Report','Peer','Supervisor','Internal Partner','External Partner','Board / Investor','Key Customer']));
