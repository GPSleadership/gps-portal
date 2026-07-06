-- ============================================================================
-- GPS Leadership Portal — Migration v91: CLIENT AVATAR
-- ============================================================================
--
--  Optional profile photo the client uploads themselves. Stored in the existing
--  public `org-assets` bucket under client-avatars/<client_id>.<ext>; this column
--  holds the resulting public URL. Set server-side by the token-scoped
--  upload-avatar endpoint (NOT client-writable directly, so a client can't point
--  it at an arbitrary URL). Falls back to an initials monogram when null.
--
--  Additive and safe. RLS deny-all to anon.
-- ============================================================================

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK: ALTER TABLE public.clients DROP COLUMN IF EXISTS avatar_url;
-- ============================================================================
