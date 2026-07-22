-- v113: consent_events — payment-point acknowledgment trail (P0-6 finish)
--
-- The survey surfaces already stamp per-participant consent on their own token
-- rows (v107). The PAYMENT POINT had no record: the checkout_notice legal text
-- was never rendered at the portal's pay CTAs and no acknowledgment was stamped.
-- This table records one append-only event each time someone clicks through a
-- pay CTA with the active checkout notice displayed, pinned to the exact
-- legal_texts version shown (text_id/version), same never-mutate principle as
-- v107.
--
-- Written server-side only (diag-portal 'checkout-notice-ack', sponsor-data
-- 'checkout-ack'). RLS deny-all; never exposed to the anon key or the generic
-- proxy.

create table if not exists public.consent_events (
  id          uuid primary key default gen_random_uuid(),
  actor_type  text not null,                              -- 'leader' | 'sponsor'
  actor_id    text not null,                              -- diagnostics.id | sponsors.id
  actor_email text,
  key         text not null,                              -- e.g. 'checkout_notice'
  text_id     uuid references public.legal_texts(id),     -- exact version shown
  version     text,
  context     text,                                       -- which surface / CTA
  created_at  timestamptz not null default now()
);

create index if not exists consent_events_actor_idx on public.consent_events (actor_type, actor_id);
create index if not exists consent_events_key_idx   on public.consent_events (key, created_at desc);

alter table public.consent_events enable row level security;

-- ROLLBACK
-- drop table if exists public.consent_events;
