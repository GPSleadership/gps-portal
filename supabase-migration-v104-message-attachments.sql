-- v104 — Multiple attachments per message (up to 5). Each coach_message can now carry
-- several files. New rows store their files here (one row per file); the legacy single-
-- file columns on coach_messages (attachment_url/name/size/type) stay readable for old
-- messages. Read path merges: child rows if any, else the legacy single. Files live in
-- the same private 'message-attachments' bucket, served via signed URLs. RLS on / no
-- policy (service-key model); FK cascade so deleting a message removes its attachments.

create table if not exists public.message_attachments (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.coach_messages(id) on delete cascade,
  path       text not null,
  name       text,
  size       bigint,
  type       text,
  created_at timestamptz default now()
);
create index if not exists idx_message_attachments_message on public.message_attachments(message_id);
alter table public.message_attachments enable row level security;

-- ROLLBACK
-- drop table if exists public.message_attachments;
