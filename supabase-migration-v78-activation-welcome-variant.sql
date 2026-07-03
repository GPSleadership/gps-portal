-- ============================================================================
-- GPS Leadership Portal — Migration v78: ACTIVATION WELCOME VARIANT
-- ============================================================================
--
--  Project #1 (Activate 90-Day Sprint). Records which coaching-activation welcome
--  email a client received, so the flow is auditable and the double-send guard is
--  explicit.
--
--    welcome_variant — 'sponsored' | 'self' | NULL (not yet activated)
--        Set together with welcome_sent_at (the existing double-send guard) when
--        the coach activates the 90-day sprint. NULL until activation.
--
--  Everything else the activation needs already exists:
--    clients: in_coaching_program, is_active_coaching, coaching_sessions_enabled,
--             coaching_program_start_date, coaching_program_end_date,
--             current_sprint_number, welcome_sent_at
--    sprints: (created per sprint)
--    sponsors: name, email, sponsor_token, confidentiality_default, linked_client_id
--
--  Additive and safe. Old code ignores the new column. RLS posture inherited
--  (clients is deny-all to anon post-v26; all access via service-role endpoints).
-- ============================================================================

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS welcome_variant TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_welcome_variant_chk'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_welcome_variant_chk
      CHECK (welcome_variant IS NULL OR welcome_variant IN ('sponsored', 'self'));
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_welcome_variant_chk;
--   ALTER TABLE clients DROP COLUMN IF EXISTS welcome_variant;
-- COMMIT;
-- ============================================================================
