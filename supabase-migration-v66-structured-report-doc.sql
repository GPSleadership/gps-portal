-- v66: structured report document (single source of truth) + business-outcome goal
-- Applied to production 2026-06-24. Additive only — old code ignores these columns.
--
-- report_doc holds the full diagnostic report as ordered, audience-tagged sections.
-- It becomes the one source that the client results snapshot, the 30/90-day plan
-- prefill, and the sponsor (Decision Room) page all draw from.
-- business_outcome_goal is the engagement-level outcome the dev plan ladders up to
-- (e.g., "Drive 3-5% annual revenue growth"), shown on the leader plan + sponsor page.

alter table diagnostics add column if not exists report_doc jsonb;
alter table clients     add column if not exists business_outcome_goal text;

comment on column diagnostics.report_doc is 'Structured diagnostic report: { version, template, generated_at, source, sections:[{key,title,audience,page_break_after,body,data}] }. audience in (all|client|sponsor|coach). Single source the client snapshot, 30/90 plan prefill, and sponsor page draw from.';
comment on column clients.business_outcome_goal is 'Engagement-level business outcome the dev plan ladders up to (e.g., "Drive 3-5% annual revenue growth"). Shown on the leader plan and the sponsor page.';

-- ROLLBACK
-- alter table diagnostics drop column if exists report_doc;
-- alter table clients     drop column if exists business_outcome_goal;
