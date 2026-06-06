-- ============================================================================
-- GPS Leadership Portal — Migration v37: ADMIN ROLES (Owner / Assistant RBAC)
-- ============================================================================
--
--  Repurposes admin_accounts.role to the role-based access scheme:
--    owner      — full control (user mgmt, templates/IP, automation, deletes,
--                 raw exports, plan unlock). Alex authenticates as owner via the
--                 MAIN coach password, not an admin_accounts row.
--    assistant  — runs day-to-day ops; cannot change IP, automation, users, or
--                 permanently delete records / export raw data.
--
--  Existing admin_accounts rows (e.g. Anna, previously role='admin') are
--  converted to 'assistant'. New admins default to 'assistant'.
--
--  Enforcement is server-side: the coach session carries `lvl` (owner|assistant)
--  and api/coach-data.js + api/get-client.js gate owner-only operations.
-- ============================================================================

UPDATE admin_accounts SET role = 'assistant' WHERE role IS NULL OR role NOT IN ('owner','assistant');
ALTER TABLE admin_accounts ALTER COLUMN role SET DEFAULT 'assistant';
ALTER TABLE admin_accounts DROP CONSTRAINT IF EXISTS admin_accounts_role_check;
-- 'admin' tolerated as a legacy value (treated as assistant by app logic) so the
-- pre-RBAC code path doesn't break during the deploy window.
ALTER TABLE admin_accounts ADD CONSTRAINT admin_accounts_role_check CHECK (role IN ('owner','assistant','admin'));

-- ============================================================================
-- ROLLBACK (manual): ALTER TABLE admin_accounts DROP CONSTRAINT IF EXISTS admin_accounts_role_check;
-- ============================================================================
