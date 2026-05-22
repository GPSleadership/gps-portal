-- ══════════════════════════════════════════════════════════════
-- GPS Leadership Solutions — Supabase Migration v2
-- Run this in Supabase → SQL Editor
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. EMAIL LOG — tracks every email sent
-- ─────────────────────────────────────────────
create table if not exists email_log (
  id           bigint generated always as identity primary key,
  sent_at      timestamptz default now(),
  client_id    uuid references clients(id) on delete set null,
  recipient_email text not null,
  recipient_name  text,
  email_type   text not null,  -- 'reminder', 'test_reminder', 'plan_submitted', 'checkin_submitted', etc.
  subject      text,
  status       text not null default 'sent',  -- 'sent' | 'error'
  error_details text,
  resend_id    text   -- Resend's message ID
);

-- Allow the serverless functions (using anon key) to insert logs
alter table email_log enable row level security;

create policy "Service can insert email_log"
  on email_log for insert
  with check (true);

create policy "Service can select email_log"
  on email_log for select
  using (true);

-- Index for dashboard queries (most recent first)
create index if not exists email_log_sent_at_idx on email_log (sent_at desc);
create index if not exists email_log_client_id_idx on email_log (client_id);


-- ─────────────────────────────────────────────
-- 2. ADMIN ACCOUNTS — EA / assistant logins
-- ─────────────────────────────────────────────
create table if not exists admin_accounts (
  id         bigint generated always as identity primary key,
  created_at timestamptz default now(),
  name       text not null,
  email      text unique,
  password   text not null,  -- plain text is fine for internal tool; change to hashed if needed
  role       text not null default 'admin',  -- 'admin' (full read+write) or 'viewer' (read-only)
  is_active  boolean not null default true,
  notes      text
);

alter table admin_accounts enable row level security;

create policy "Service can manage admin_accounts"
  on admin_accounts for all
  with check (true);

create policy "Service can read admin_accounts"
  on admin_accounts for select
  using (true);


-- ─────────────────────────────────────────────
-- 3. CHECK-IN DRAFTS — saves in-progress check-ins
-- ─────────────────────────────────────────────
create table if not exists checkin_drafts (
  id          bigint generated always as identity primary key,
  saved_at    timestamptz default now(),
  client_id   uuid not null references clients(id) on delete cascade,
  week_number int not null,
  data        jsonb not null,  -- serialized form fields
  unique (client_id, week_number)  -- one draft per client per week
);

alter table checkin_drafts enable row level security;

create policy "Anyone can upsert drafts"
  on checkin_drafts for insert
  with check (true);

create policy "Anyone can update drafts"
  on checkin_drafts for update
  using (true);

create policy "Anyone can read drafts"
  on checkin_drafts for select
  using (true);

create policy "Anyone can delete drafts"
  on checkin_drafts for delete
  using (true);

-- ══════════════════════════════════════════════════════════════
-- Done. Verify by running:
--   select table_name from information_schema.tables
--   where table_schema = 'public'
--   order by table_name;
-- ══════════════════════════════════════════════════════════════
