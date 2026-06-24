-- v67: sponsor-outcome focus flag
-- Applied to production 2026-06-24. Additive only — old code ignores this column.
--
-- Distinguishes a SPONSOR-DRIVEN engagement (the sponsor wants this leader developed
-- toward a specific outcome: succession, promotion-readiness, right-person-for-the-job,
-- or a business result) from PURE SELF-DEVELOPMENT. When false, business_outcome_goal
-- is hidden everywhere (leader plan + sponsor Decision Room), even if a value exists.
-- Set via a checkbox in the coach report editor.

alter table clients add column if not exists sponsor_outcome_focus boolean not null default false;

comment on column clients.sponsor_outcome_focus is 'True when the engagement is sponsor-driven toward a specific outcome (succession, promotion-readiness, right-person-for-the-job, a business result). When false it is pure self-development and business_outcome_goal is hidden everywhere. Set via the coach report editor checkbox.';

-- Backfill: existing rows that already have a business outcome are treated as sponsor-driven.
update clients set sponsor_outcome_focus = true where business_outcome_goal is not null and business_outcome_goal <> '';

-- ROLLBACK
-- alter table clients drop column if exists sponsor_outcome_focus;
