-- v69: reliability hardening (R1+R2) — applied to production 2026-06-24. Additive.
--
-- (1) email_log.sent_at gets a default so a null timestamp can never hide an error
--     row from the detector's 24h window.
-- (2) cron_heartbeats: each scheduled job records last_run_at; detect_breakages flags
--     any cron overdue past 1.5x its expected interval. This catches whole-function
--     failures (e.g. a bad column) that skip the job WITHOUT writing an email error row
--     — exactly how the survey-reminders continuation sequence died unnoticed.
-- (3) detect_breakages() rewritten: email-delivery failures escalated to P1 (so the
--     daily brief, which surfaces P0/P1, shows them); cron-overdue detection added;
--     email + cron findings self-heal when the signal recovers; search_path hardened.

alter table email_log alter column sent_at set default now();

create table if not exists cron_heartbeats (
  cron_name text primary key,
  last_run_at timestamptz not null default now(),
  last_status text not null default 'ok',
  last_detail text,
  expected_interval_minutes int not null default 1440,
  updated_at timestamptz not null default now()
);
alter table cron_heartbeats enable row level security;  -- service-role only; no anon policies

insert into cron_heartbeats (cron_name, expected_interval_minutes, last_run_at) values
  ('ops-monitor', 360, now()),
  ('survey-reminders', 1440, now()),
  ('send-reminders', 10080, now()),
  ('diagnostic-reminders', 1440, now()),
  ('trial-sweep', 1440, now())
on conflict (cron_name) do update set expected_interval_minutes = excluded.expected_interval_minutes;

-- detect_breakages(): full current definition is applied to prod (see migration history).
-- Key changes vs v68: severity 'P1' for email_fail; new cron_overdue:* findings from
-- cron_heartbeats; self-heal for email_fail (latest send 'sent') and cron_overdue
-- (heartbeat fresh); SET search_path = public, pg_temp. Each Vercel cron upserts its
-- own cron_heartbeats row at the end of a successful run.

-- ROLLBACK
-- drop table if exists cron_heartbeats;
-- alter table email_log alter column sent_at drop default;
-- (restore detect_breakages from v68 if needed)
