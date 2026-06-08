-- Migration v42: Add TP3 score columns to clients table
-- Applied: 2026-06-08
-- Purpose: Store 14-Day Diagnostic TP3 scores (self + others) per client
--          for display in the My Results tab of the client portal.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS tp3_trust_self        numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_proactivity_self   numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_productivity_self  numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_index_self         numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_trust_others       numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_proactivity_others numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_productivity_others numeric(3,2),
  ADD COLUMN IF NOT EXISTS tp3_index_others       numeric(3,2);

-- ROLLBACK:
-- ALTER TABLE clients
--   DROP COLUMN IF EXISTS tp3_trust_self,
--   DROP COLUMN IF EXISTS tp3_proactivity_self,
--   DROP COLUMN IF EXISTS tp3_productivity_self,
--   DROP COLUMN IF EXISTS tp3_index_self,
--   DROP COLUMN IF EXISTS tp3_trust_others,
--   DROP COLUMN IF EXISTS tp3_proactivity_others,
--   DROP COLUMN IF EXISTS tp3_productivity_others,
--   DROP COLUMN IF EXISTS tp3_index_others;
