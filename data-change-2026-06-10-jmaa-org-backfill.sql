-- Data change (not schema) — applied to prod 2026-06-10 via Supabase MCP.
-- Why: the 23 JMAA assessment participants were created from a roster that had no
-- Organization column, so their client.organization was NULL. Backfilled to match
-- the engagement's org so they show as Jackson Municipal Airport Authority everywhere.
-- Only filled blanks (never clobbered an existing value).

UPDATE clients c
SET organization = 'Jackson Municipal Airport Authority (JMAA)'
FROM workshop_participants wp
WHERE wp.client_id = c.id
  AND wp.workshop_id = '0c4ace85-9093-4ac2-8096-88fdcea97e73'
  AND (c.organization IS NULL OR btrim(c.organization) = '');

-- Going forward this is automatic: api/workshop-data.js `upload-roster` now inherits
-- the engagement org onto any participant who has no org on file (row org still wins),
-- and the coach roster has a per-person Tie / Untie control + `set-participant-org` action.
