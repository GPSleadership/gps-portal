-- v65: Sponsor review/approval of a leader's 90-day plan.
-- Additive only. Old code ignores these columns.
--
-- plan_requires_sponsor_approval: per-leader switch (coach sets it). When true, the
--   plan must be approved by the sponsor before it's locked/launched.
-- organizations.plan_requires_sponsor_approval: org default (e.g. JMAA/Rosa = true)
--   so the coach doesn't set it per person; the wizard/coach UI can inherit it.
-- plan_sponsor_status: lifecycle of the sponsor decision.
--   'none'  (approval not required) · 'pending' (awaiting sponsor) ·
--   'approved' · 'changes_requested'
-- plan_sponsor_decided_at / plan_sponsor_note: when + why (sponsor's note on changes).

ALTER TABLE diagnostics
  ADD COLUMN IF NOT EXISTS plan_requires_sponsor_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plan_sponsor_status   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS plan_sponsor_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_sponsor_note     text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_requires_sponsor_approval boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN diagnostics.plan_requires_sponsor_approval IS
  'When true, the sponsor must approve the 90-day plan before it is locked. Coach-set; may inherit organizations.plan_requires_sponsor_approval.';
COMMENT ON COLUMN diagnostics.plan_sponsor_status IS
  'none | pending | approved | changes_requested';

-- diagnostics + organizations already have RLS with no anon policies (service-role
-- only). Read/write exclusively through token/session-validated endpoints.

-- ============================================================================
-- ROLLBACK
-- ALTER TABLE diagnostics
--   DROP COLUMN IF EXISTS plan_requires_sponsor_approval,
--   DROP COLUMN IF EXISTS plan_sponsor_status,
--   DROP COLUMN IF EXISTS plan_sponsor_decided_at,
--   DROP COLUMN IF EXISTS plan_sponsor_note;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS plan_requires_sponsor_approval;
-- ============================================================================
