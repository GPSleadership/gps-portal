-- v99 — report_flow_settings: global, admin-controlled gates for the diagnostic report flow.
-- Singleton row (id=1). Booleans default TRUE = current behavior (PDF + plan both required
-- before publish). Turning one OFF makes that step optional (non-blocking) in the stepper.
-- The Review step is a permanent hard gate and is intentionally NOT configurable here.
-- Additive; old code ignores the table.

create table if not exists report_flow_settings (
  id                 int primary key default 1,
  require_plan_draft boolean not null default true,
  require_pdf_upload boolean not null default true,
  updated_at         timestamptz default now(),
  constraint report_flow_settings_singleton check (id = 1)
);

insert into report_flow_settings (id) values (1) on conflict (id) do nothing;

-- Lock down to match the rest of the schema (coach-only, served via service-key endpoints).
-- RLS enabled + no policy blocks the public/anon API; the service role still bypasses it.
alter table public.report_flow_settings enable row level security;

-- ROLLBACK
-- drop table if exists report_flow_settings;
