-- v110: pricing_audit — audit trail for every pricing/config/credit change
--
-- P0-5. Every coach-gated write through api/pricing.js (config edit, client
-- snapshot, credit override) appends one row here with the before/after state,
-- who did it, and why. Append-only: nothing in the app ever updates or deletes
-- audit rows.
--
-- Security: RLS deny-all (no policies). Written and read ONLY via service-role
-- endpoints (owner-gated actions in api/pricing.js). Never exposed to anon.

create table if not exists public.pricing_audit (
  id         uuid primary key default gen_random_uuid(),
  actor      text not null,              -- coach email from the session
  action     text not null,              -- config-save | snapshot-client | credit-override
  client_id  text,                       -- null for global config changes
  before     jsonb,
  after      jsonb,
  reason     text,
  created_at timestamptz not null default now()
);

create index if not exists pricing_audit_client_idx  on public.pricing_audit (client_id);
create index if not exists pricing_audit_created_idx on public.pricing_audit (created_at desc);

alter table public.pricing_audit enable row level security;

-- ROLLBACK
-- drop table if exists public.pricing_audit;
