-- v117: fix self_checks checkpoint constraint (LIVE P0 — blocked leaders at the
-- results gate).
--
-- The self-check that gates a leader's re-score results sends checkpoint='day30'
-- (client.html; survey checkpoints are baseline/day30/day90). But the CHECK
-- constraint only permitted ('day45','day90') — a stale value from before the
-- re-score cadence moved to 30 days. Result: EVERY day30 self-check insert failed
-- with 23514, the leader saw "Could not save self-check", and could not view their
-- results. self_checks was empty (no self-check had ever saved). Found live via
-- Sergio Sabido 2026-07-22.
--
-- Fix: widen the constraint to the checkpoints the app actually uses, keeping the
-- legacy 'day45' so nothing that referenced it breaks. Loosening a CHECK is safe
-- and additive; no rows to revalidate.

alter table public.self_checks drop constraint if exists self_checks_checkpoint_check;
alter table public.self_checks add constraint self_checks_checkpoint_check
  check (checkpoint in ('baseline', 'day30', 'day45', 'day90'));

-- ROLLBACK
-- alter table public.self_checks drop constraint if exists self_checks_checkpoint_check;
-- alter table public.self_checks add constraint self_checks_checkpoint_check
--   check (checkpoint in ('day45', 'day90'));
