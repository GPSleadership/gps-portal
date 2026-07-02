-- ============================================================================
-- GPS Leadership Portal — Migration v77: STAKEHOLDER PULSE CADENCE
-- ============================================================================
--
--  Stage 3 of the check-in engagement loop. Adds a per-client cadence TIER for
--  the recurring stakeholder pulse (distinct from `coaching_cadence`, which is
--  the LEADER's own session cadence — weekly/biweekly/monthly — and is left
--  unchanged here).
--
--    pulse_cadence_tier — 'aggressive' | 'light' | 'off'
--        aggressive = 3 pulses  (day30 + day45 + day90 checkpoints)
--        light      = 2 pulses  (day45 + day90)   ← default for renewals
--        off        = 0 pulses  (leader-only; no stakeholder pulses)
--      Sprint 1 is scheduled as 'aggressive' by the coach picker; post-90 /
--      renewal defaults to 'light' unless a genuinely new behavior warrants
--      restarting the aggressive window.
--
--    pulse_tapered_at — set when auto-taper fires (a behavior scored 4+/5 across
--        raters on 2 consecutive pulses), which cancels the remaining scheduled
--        pulses for that client+sprint. Recorded so the coach UI can show why a
--        cadence stopped early. NULL = not tapered.
--
--  Outward pulse labels are 30/45/90; internal send offsets are day 21/45/80
--  (sent ~1 week early to absorb response lag so reads land by the 30/90 marks).
--  Sends are shifted to the next weekday (business days only) at 9am ET.
--
--  Additive and safe. Old code ignores the new columns. RLS posture inherited
--  (clients is deny-all to anon post-v26; all access via service-role endpoints).
-- ============================================================================

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pulse_cadence_tier TEXT NOT NULL DEFAULT 'light';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pulse_tapered_at TIMESTAMPTZ;

-- Guard the tier vocabulary (idempotent: only add if not already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_pulse_cadence_tier_chk'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_pulse_cadence_tier_chk
      CHECK (pulse_cadence_tier IN ('aggressive', 'light', 'off'));
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pulse_cadence_tier_chk;
--   ALTER TABLE clients DROP COLUMN IF EXISTS pulse_tapered_at;
--   ALTER TABLE clients DROP COLUMN IF EXISTS pulse_cadence_tier;
-- COMMIT;
-- ============================================================================
