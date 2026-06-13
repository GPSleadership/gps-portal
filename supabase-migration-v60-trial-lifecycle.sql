-- ════════════════════════════════════════════════════════════════════════════
-- v60: trial-account lifecycle (2026-06-13)
-- Additive only. Supports auto-archiving dormant workshop-guest ("trial")
-- accounts so the coach dashboard stays clean, WITHOUT touching real clients.
--   account_type  — 'client' (real coaching/diagnostic client, protected) or
--                   'trial' (workshop guest). Defaults 'client' so no existing
--                   row is ever mistaken for a trial.
--   invited_at    — when the trial guest got portal access (drives day-3/8/10 clock).
--   activated_at  — stamped when the guest onboards (plan submitted + >=1 check-in).
--   trial_nudge_3_sent_at / trial_nudge_8_sent_at — reserved for the day-3/day-8
--                   nudge emails (fast follow; columns added now to stay additive).
-- is_archived already exists and is reused. The sweep NEVER touches
-- in_coaching_program=true clients or any client linked to a diagnostics row.
-- ════════════════════════════════════════════════════════════════════════════

alter table clients add column if not exists account_type text not null default 'client';
alter table clients add column if not exists invited_at timestamptz;
alter table clients add column if not exists activated_at timestamptz;
alter table clients add column if not exists trial_nudge_3_sent_at timestamptz;
alter table clients add column if not exists trial_nudge_8_sent_at timestamptz;

-- Backfill: existing workshop guests become trials, dated from creation.
update clients
  set account_type = 'trial',
      invited_at = coalesce(invited_at, created_at)
  where is_workshop_participant = true and account_type = 'client';

-- Stamp activated_at for any trial already onboarded (plan submitted + a check-in).
update clients c
  set activated_at = coalesce(c.activated_at, c.plan_submitted_at)
  where c.account_type = 'trial'
    and c.plan_submitted_at is not null
    and exists (select 1 from checkins ck where ck.client_id = c.id);

-- ROLLBACK
-- alter table clients drop column if exists trial_nudge_8_sent_at;
-- alter table clients drop column if exists trial_nudge_3_sent_at;
-- alter table clients drop column if exists activated_at;
-- alter table clients drop column if exists invited_at;
-- alter table clients drop column if exists account_type;
