-- v101 — 90-day stakeholder pulse target (coach-owned, recommended, approved+locked).
-- pulse_target_90: the target average on the 1-5 pulse scale that the day-90 stakeholder
-- read must clear for the 90-day goal to count as "reached". Coach sets it (default
-- recommendation = pulse baseline avg + 0.5), then approves + locks it. The lock fields
-- are the audit trail that makes delegation to a sub-coach trustworthy.
-- Additive + backward compatible: old code ignores these columns; a null target means
-- the 90-day outcome gate simply isn't armed yet (no false "reached").

alter table public.clients
  add column if not exists pulse_target_90          numeric,
  add column if not exists pulse_target_90_locked_at timestamptz,
  add column if not exists pulse_target_90_locked_by text;

-- ROLLBACK
-- alter table public.clients
--   drop column if exists pulse_target_90,
--   drop column if exists pulse_target_90_locked_at,
--   drop column if exists pulse_target_90_locked_by;
