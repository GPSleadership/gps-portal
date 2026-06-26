-- v75 — branching coaching-call check-in (scheduled? → attended? → why not).
-- Applied to project pbnkefuqpoztcxfagiod on 2026-06-26.
-- attended_coaching already exists. These two are additive + nullable.
alter table public.checkins
  add column if not exists coaching_call_scheduled boolean,  -- was a call on the calendar this week
  add column if not exists coaching_missed_reason text;       -- if scheduled but not attended, why
