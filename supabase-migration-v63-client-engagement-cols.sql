-- ════════════════════════════════════════════════════════════════════════════
-- v63: restore client engagement columns (2026-06-14)
-- Additive only. api/testimonial.js reads engagement_type, first_big_win_flag,
-- sector_type from clients (and the coach handlers WRITE first_big_win_flag and
-- engagement_type) — but these columns are absent in production (a prior
-- migration that added them was reverted/never applied), so authClient's SELECT
-- 400s and silently breaks the entire testimonial/referral flow. Re-adding them
-- as nullable makes those references valid again and provides the engagement_type
-- field the portal's visibility/tier logic relies on.
--
-- Behavior-neutral: all columns nullable / default false; existing rows unaffected.
-- ════════════════════════════════════════════════════════════════════════════

alter table clients add column if not exists engagement_type   text;     -- 'diagnostic_only' | 'diagnostic_plus_coaching' | null (app-enforced)
alter table clients add column if not exists first_big_win_flag boolean not null default false;
alter table clients add column if not exists sector_type        text;

-- ROLLBACK
-- alter table clients drop column if exists sector_type;
-- alter table clients drop column if exists first_big_win_flag;
-- alter table clients drop column if exists engagement_type;
