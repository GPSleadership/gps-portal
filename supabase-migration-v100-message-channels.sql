-- v100 — Message channel split: separate Alex's confidential 1:1 coach thread from the
-- EA/coordinator (admin) thread, per client. A leader can hold two threads at once:
--   channel='coach' — private between the leader and Alex (owner-only by default)
--   channel='admin' — coordinator/EA thread (owner + granted assistants)
-- Assistants see 'admin' only unless the owner grants can_read_coach_messages.
-- Additive + backward compatible: existing conversations default to 'coach', so no
-- historical thread changes hands. Old code that ignores the column keeps working.

-- 1) Channel column on conversations (existing rows become the confidential coach thread).
alter table public.coach_conversations
  add column if not exists channel text not null default 'coach'
  check (channel in ('coach', 'admin'));

-- One thread per (client, channel) so find-or-create stays stable.
create unique index if not exists coach_conversations_client_channel_uidx
  on public.coach_conversations (client_id, channel);

-- 2) Per-assistant grant: read Alex's confidential coach thread. Default FALSE = coordinator
--    view only (admin channel). Owner flips this in Admin Accounts when needed.
alter table public.admin_accounts
  add column if not exists can_read_coach_messages boolean not null default false;

-- ROLLBACK
-- drop index if exists coach_conversations_client_channel_uidx;
-- alter table public.coach_conversations drop column if exists channel;
-- alter table public.admin_accounts drop column if exists can_read_coach_messages;
