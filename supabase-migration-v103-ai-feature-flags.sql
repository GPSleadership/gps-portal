-- v103 — AI kill-switch foundation. One row per AI feature; missing row = ON by
-- default. An owner can flip enabled=false to disable that feature and fall back to
-- an analog/manual path (never a hard error). Cost/vendor hedge — Alex does not want
-- the practice locked into AI. Served via service key only (RLS on, no anon policy).
-- Wires the FIRST feature (coaching_brief, the AI talking-track draft); the other 7
-- AI endpoints get retrofitted under P1-AI1/2.

create table if not exists public.ai_feature_flags (
  feature    text primary key,
  enabled    boolean not null default true,
  label      text,
  updated_at timestamptz default now()
);

insert into public.ai_feature_flags (feature, enabled, label) values
  ('coaching_brief', true, 'AI coaching talking-track draft')
on conflict (feature) do nothing;

alter table public.ai_feature_flags enable row level security;

-- ROLLBACK
-- drop table if exists public.ai_feature_flags;
