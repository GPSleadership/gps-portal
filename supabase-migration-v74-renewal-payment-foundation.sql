-- v74 — Renewal / Payment system, Phase 1 foundation (additive, no behavior change)
-- Applied to project pbnkefuqpoztcxfagiod on 2026-06-26.
-- GHL is system of record for money; this schema holds the portal's engagement state,
-- an editable config for GHL links/prices/windows, and a renewals ledger.

-- Per-leader billing/engagement fields on clients
alter table public.clients
  add column if not exists payer_type text default 'leader_pays',      -- leader_pays | sponsor_pays
  add column if not exists subscription_status text default 'none',     -- none | flex_monthly | titan_quarterly | canceled | past_due
  add column if not exists next_renewal_at timestamptz,                 -- drives the 7-day pre-charge notice
  add column if not exists ghl_subscription_id text,
  add column if not exists sponsor_contact_id text;

-- Renewals ledger: every payment that advances or continues an engagement
create table if not exists public.renewals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id),
  product_key text not null,        -- first_sprint_credit | first_sprint_standard | continuation_flex_monthly | continuation_titan_quarterly
  amount numeric,
  period text,                      -- one_time | monthly | quarterly
  ghl_payment_id text unique,       -- idempotency key from GHL/Make
  payer_type text,
  source text default 'portal_button',
  created_at timestamptz default now()
);
create index if not exists idx_renewals_client on public.renewals (client_id);

-- Editable renewal config (GHL links, prices, windows) — singleton row id=1
create table if not exists public.renewal_config (
  id integer primary key default 1,
  first_sprint_credit_url text,
  first_sprint_standard_url text,
  continuation_flex_url text,
  continuation_titan_url text,
  price_first_credit integer default 10000,
  price_first_standard integer default 15000,
  price_flex_monthly integer default 5000,
  price_titan_quarterly integer default 13500,
  credit_window_days integer default 30,
  grace_window_days integer default 7,
  precharge_notice_days integer default 7,
  updated_at timestamptz default now(),
  constraint renewal_config_singleton check (id = 1)
);
insert into public.renewal_config (id) values (1) on conflict (id) do nothing;

-- Match portal security posture: deny-all to anon; service-role endpoints bypass RLS.
alter table public.renewals enable row level security;
alter table public.renewal_config enable row level security;
