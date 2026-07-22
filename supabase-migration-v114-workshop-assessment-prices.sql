-- v114: workshop + assessment price points on pricing_config
--
-- Alex 2026-07-22: workshops and assessments have real price points (full day
-- $10,000 · half day $7,500 · assessment $4,500) but no home in the system.
-- These columns make Settings → Pricing the single place of record. NOTHING
-- charges from them yet — workshop/assessment checkout wiring is a later build;
-- proposals and future builds read from here.
--
-- Additive only; old code ignores the new columns.

alter table public.pricing_config
  add column if not exists workshop_full_day_price numeric,
  add column if not exists workshop_half_day_price numeric,
  add column if not exists assessment_price        numeric;

-- Seed the confirmed price points only where empty (never overwrites an edit).
update public.pricing_config
   set workshop_full_day_price = coalesce(workshop_full_day_price, 10000),
       workshop_half_day_price = coalesce(workshop_half_day_price, 7500),
       assessment_price        = coalesce(assessment_price, 4500)
 where id = 1;

-- ROLLBACK
-- alter table public.pricing_config drop column if exists workshop_full_day_price;
-- alter table public.pricing_config drop column if exists workshop_half_day_price;
-- alter table public.pricing_config drop column if exists assessment_price;
