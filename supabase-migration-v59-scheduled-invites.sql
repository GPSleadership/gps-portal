-- ════════════════════════════════════════════════════════════════════════════
-- v59: time-release diagnostic invites (2026-06-13)
-- Additive only. A coach can schedule rater invites to auto-send at a chosen
-- date/time instead of sending immediately.
--   invites_scheduled_at        — when the invites should auto-send (null = not scheduled)
--   invites_schedule_claimed_at — set by the cron when it claims a due row, so
--                                 overlapping cron runs never double-process the
--                                 same diagnostic. Cleared if a send fully fails
--                                 (safe to retry — the per-rater invited_at guard
--                                 means already-invited raters are never re-emailed).
-- Fire-once is enforced by the existing diagnostics.invites_sent_at guard plus
-- the per-rater diagnostic_raters.invited_at guard; this claim column only
-- prevents concurrent double-processing. Old code ignores both new columns.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostics
  add column if not exists invites_scheduled_at timestamptz;

alter table diagnostics
  add column if not exists invites_schedule_claimed_at timestamptz;

-- Helps the cron query (due, not yet sent) stay cheap as the table grows.
create index if not exists idx_diagnostics_invites_scheduled_at
  on diagnostics (invites_scheduled_at)
  where invites_scheduled_at is not null and invites_sent_at is null;

-- ROLLBACK
-- drop index if exists idx_diagnostics_invites_scheduled_at;
-- alter table diagnostics drop column if exists invites_schedule_claimed_at;
-- alter table diagnostics drop column if exists invites_scheduled_at;
