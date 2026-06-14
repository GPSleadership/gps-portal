-- ════════════════════════════════════════════════════════════════════════════
-- v62: Contact Your Coach — in-app coach/client messaging (2026-06-14)
-- Additive only. Two new tables, unused until the messaging code ships, so this
-- is safe to apply ahead of the feature. No changes to existing tables.
--
-- Security: both tables are served ONLY through service-key serverless endpoints
-- (token-scoped on the client side, coach-session-gated on the coach side).
-- The browser never queries them directly. RLS is left enabled with no public
-- policy so the anon key cannot read them even if it were ever used.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists coach_conversations (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  status          text not null default 'open'
                    check (status in ('open', 'waiting_on_client', 'closed')),
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One active conversation per client keeps the thread model simple (status can be
-- reopened). Enforced in app logic; index supports the inbox ordering + lookups.
create index if not exists idx_coach_conversations_client    on coach_conversations (client_id);
create index if not exists idx_coach_conversations_last_msg  on coach_conversations (last_message_at desc nulls last);

create table if not exists coach_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references coach_conversations(id) on delete cascade,
  client_id       uuid not null references clients(id) on delete cascade,
  sender_role     text not null check (sender_role in ('client', 'coach')),
  message_type    text not null default 'quick_question'
                    check (message_type in ('quick_question', 'prep_for_session', 'progress_update', 'win', 'logistics')),
  message_text    text not null,
  attachment_url  text,
  read_by_coach   boolean not null default false,
  read_by_client  boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists idx_coach_messages_conversation on coach_messages (conversation_id, created_at);
create index if not exists idx_coach_messages_client       on coach_messages (client_id);
-- Coach inbox "needs reply": last message from client, unread by coach.
create index if not exists idx_coach_messages_unread_coach on coach_messages (read_by_coach) where read_by_coach = false;

alter table coach_conversations enable row level security;
alter table coach_messages      enable row level security;

-- ROLLBACK
-- drop table if exists coach_messages;
-- drop table if exists coach_conversations;
