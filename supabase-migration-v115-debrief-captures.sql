-- v115: debrief_captures — the coach's debrief outcome + appetite scores
--
-- The AI Debrief Script itself is generated fresh on demand (always in sync with
-- the current report + 90-day draft), so it is NOT stored. What we DO store is
-- what the coach captures during the live debrief: the three 1-10 touchpoints and
-- the outcome. This is the debrief -> sprint conversion funnel.
--
--   value_pre  : "how valuable has this been so far?" asked before the portal tour
--   value_end  : "how valuable was our time together today?" asked at the close
--   appetite   : "how helpful would 90 days of support be?" asked at the close
--   outcome    : yes | thinking | no  (did it convert to a sprint)
--   funding_type : self | sponsor  (drives whether the script speaks price aloud)
--
-- One row per diagnostic. RLS deny-all; written only through the coach-gated
-- api/debrief-script endpoint with the service key. Never exposed to anon.

create table if not exists public.debrief_captures (
  diagnostic_id  uuid primary key references public.diagnostics(id) on delete cascade,
  funding_type   text,
  value_pre      smallint check (value_pre  between 1 and 10),
  value_end      smallint check (value_end  between 1 and 10),
  appetite       smallint check (appetite   between 1 and 10),
  outcome        text check (outcome in ('yes','thinking','no')),
  notes          text,
  captured_by    text,
  captured_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists debrief_captures_outcome_idx on public.debrief_captures (outcome);

alter table public.debrief_captures enable row level security;

-- ROLLBACK
-- drop table if exists public.debrief_captures;
