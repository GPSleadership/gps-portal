-- ============================================================================
-- GPS Leadership Portal — Migration v32: AD-HOC EXTERNAL FEEDBACK INVITES
-- ============================================================================
--
--  The coach can request a one-off observation from an external person (board
--  member, customer, partner). We email them a unique link; they submit a short
--  observation + level; it lands as an external_signal (visible_to_client=false)
--  the coach approves before it shows on the sponsor page.
--
--    external_feedback_invites — one row per request, token-addressed.
--      token        — unguessable link token (set by the server).
--      team_id      — the team the observation is about.
--      submitted_at — set when they respond (single-use).
--
--  RLS: deny-all to anon/authenticated (service-role endpoints only), same as
--  the rest of the post-v26 schema. The submission page reaches it only through
--  the token-validated serverless endpoint.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS external_feedback_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT NOT NULL UNIQUE,
  team_id      UUID REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT,
  email        TEXT,
  by_role      TEXT,
  sent_at      TIMESTAMPTZ DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_efi_token ON external_feedback_invites(token);
CREATE INDEX IF NOT EXISTS idx_efi_team  ON external_feedback_invites(team_id);

ALTER TABLE external_feedback_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON external_feedback_invites FROM anon, authenticated;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   DROP TABLE IF EXISTS external_feedback_invites;
-- COMMIT;
-- ============================================================================
