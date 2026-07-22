-- v109: pricing_config + client_pricing_snapshot + diagnostic_credit() — repo record
--
-- P0-5 (config-driven pricing + credit). These objects were applied to production
-- Supabase on 2026-07-18 from a working session before this migration file was
-- committed; this file is the canonical repo record and is fully idempotent, so
-- re-applying it is a no-op. The frontier-batch branch builds api/pricing.js on top.
--
-- Policy this schema enforces (from the build spec):
--   * Only the STANDARD diagnostic price is creditable. Tier upgrades / add-ons are
--     delivered services and are never credited.
--   * credit = min(coalesce(credit_override, amount_paid), standard_diagnostic_price)
--   * Unknown amount_paid -> credit the standard price (the maximum), never more.
--   * client_pricing_snapshot freezes a client's quoted terms at engagement time so a
--     later price change never rewrites an existing client's offer.
--   * pricing_config.confirmed stays FALSE until Alex confirms the real numbers.
--
-- Security: RLS deny-all on both tables (no policies). Served ONLY through
-- service-role endpoints (api/pricing.js, api/diag-portal.js). Never the anon key.

-- ── 1. Single admin-editable pricing row ─────────────────────────────────────
create table if not exists public.pricing_config (
  id                        integer primary key,
  standard_diagnostic_price numeric,
  pro_diagnostic_price      numeric,
  coaching_monthly          numeric,
  sprint_months             smallint,
  credit_window_days        smallint,
  confirmed                 boolean not null default false,
  updated_at                timestamptz not null default now()
);

alter table public.pricing_config enable row level security;

-- Seed (draft numbers, confirmed=false) only if the row doesn't exist yet.
insert into public.pricing_config
  (id, standard_diagnostic_price, pro_diagnostic_price, coaching_monthly, sprint_months, credit_window_days, confirmed)
select 1, 5000, 10000, 5000, 3, 7, false
where not exists (select 1 from public.pricing_config where id = 1);

-- ── 2. Per-client freeze of quoted terms ─────────────────────────────────────
create table if not exists public.client_pricing_snapshot (
  client_id                 text primary key,
  standard_diagnostic_price numeric,
  pro_diagnostic_price      numeric,
  coaching_monthly          numeric,
  sprint_months             smallint,
  credit_window_days        smallint,
  amount_paid               numeric,
  credit_override           numeric,
  override_reason           text,
  override_by               text,
  snapshot_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table public.client_pricing_snapshot enable row level security;

-- ── 3. Credit function (server-side single source of truth) ──────────────────
create or replace function public.diagnostic_credit(p_client_id text)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare snap public.client_pricing_snapshot%rowtype;
        cfg  public.pricing_config%rowtype;
        std  numeric; paid numeric; credit numeric;
begin
  select * into cfg from public.pricing_config where id = 1;
  select * into snap from public.client_pricing_snapshot where client_id = p_client_id;
  std  := coalesce(snap.standard_diagnostic_price, cfg.standard_diagnostic_price);
  if std is null then return 0; end if;
  if snap.credit_override is not null then
    return least(snap.credit_override, std);   -- an override still can't exceed standard
  end if;
  paid := snap.amount_paid;                     -- unknown paid -> credit the standard (the max), never more
  credit := least(coalesce(paid, std), std);
  return greatest(credit, 0);
end;
$function$;

revoke all on function public.diagnostic_credit(text) from public, anon, authenticated;
grant execute on function public.diagnostic_credit(text) to service_role;

-- Test cases (run manually; do not leave test rows behind):
--   Pro client paid 10000, standard 5000  -> diagnostic_credit(id) = 5000
--   Standard client paid 5000             -> 5000
--   Unknown client / no snapshot          -> 5000 (config standard)
--   Override 2500 (partial scholarship)   -> 2500

-- ROLLBACK
-- drop function if exists public.diagnostic_credit(text);
-- drop table if exists public.client_pricing_snapshot;
-- drop table if exists public.pricing_config;
