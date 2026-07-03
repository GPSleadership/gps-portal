-- ============================================================================
-- GPS Leadership Portal — Migration v79: COACHING SESSION COUNTDOWN
-- ============================================================================
--
--  Roadmap #3. Tracks coaching sessions as a countdown per engagement:
--    coaching_sessions_total     — sessions the client paid for (coach-set)
--    coaching_sessions_completed — sessions logged so far (coach increments)
--    show_sessions_to_leader     — whether the leader sees a (softened) momentum
--                                  view. Coach + sponsor always see the count;
--                                  the leader sees momentum framing, never a bare
--                                  "sessions remaining" meter or a renew CTA.
--
--  "Call N of M" = completed of total. Renewal trigger fires coach-side when
--  (total - completed) <= 2. Leader momentum phase is derived server-side from
--  completed/total (early / mid / consolidation) — the raw count never reaches
--  the leader's browser.
--
--  Additive and safe. Old code ignores the new columns. RLS deny-all to anon
--  (post-v26); all access via service-role endpoints.
-- ============================================================================

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS coaching_sessions_total     INTEGER,
  ADD COLUMN IF NOT EXISTS coaching_sessions_completed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS show_sessions_to_leader     BOOLEAN NOT NULL DEFAULT false;

-- Guard against negative / nonsensical counts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_sessions_nonneg_chk') THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_sessions_nonneg_chk
      CHECK (
        (coaching_sessions_total IS NULL OR coaching_sessions_total >= 0)
        AND coaching_sessions_completed >= 0
      );
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sessions_nonneg_chk;
--   ALTER TABLE clients DROP COLUMN IF EXISTS show_sessions_to_leader;
--   ALTER TABLE clients DROP COLUMN IF EXISTS coaching_sessions_completed;
--   ALTER TABLE clients DROP COLUMN IF EXISTS coaching_sessions_total;
-- COMMIT;
-- ============================================================================
