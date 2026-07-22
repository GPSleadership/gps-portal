-- v112: email_drafts failure handling — attempts counter, last error, terminal 'failed'
--
-- P1 (frontier batch 5E). Before this, a failing scheduled draft stayed
-- status='scheduled' forever: the 15-minute send-scheduled cron and the Monday
-- send-reminders backup both retried it on every pass, with no cap and no alert.
-- Now every failed attempt is stamped (attempts + last_error + last_attempt_at),
-- retries stop at 5 attempts (status flips to 'failed'), and hitting the cap
-- raises a P1 cio_findings row so the daily brief surfaces it to Alex.
--
-- Additive only; old code ignores the new columns.

alter table public.email_drafts
  add column if not exists attempts        integer not null default 0,
  add column if not exists last_error      text,
  add column if not exists last_attempt_at timestamptz;

-- ROLLBACK
-- alter table public.email_drafts drop column if exists attempts;
-- alter table public.email_drafts drop column if exists last_error;
-- alter table public.email_drafts drop column if exists last_attempt_at;
