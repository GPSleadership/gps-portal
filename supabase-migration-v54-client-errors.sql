-- ════════════════════════════════════════════════════════════════════════════
-- v54: client_errors — browser-side error capture (P1 #8)
-- Additive only. Writes go through /api/log-error (service role).
-- No anon policies: deny-all for the browser, matching the post-v26 model.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists client_errors (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  kind        text not null default 'onerror',  -- onerror | unhandledrejection
  page        text,
  message     text,
  stack       text,
  source_url  text,
  line_no     integer,
  col_no      integer,
  user_agent  text,
  token_hint  text  -- first 8 chars of the portal token (identifies who hit it without storing the full credential)
);

alter table client_errors enable row level security;

create policy service_role_all on client_errors
  for all to service_role using (true) with check (true);

-- ROLLBACK
-- drop table if exists client_errors;
