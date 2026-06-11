-- Migration v49: clients.website (optional). Applied to prod 2026-06-10. Additive.
-- Why: replaced the obsolete "Diagnostic Report Link" field on the Add Client form
-- (diagnostics now run in-portal) with an optional Company Website. The website is
-- passed to the diagnostic report generator as light background context only — flagged
-- in the prompt as possibly outdated and never authoritative.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS website text;

-- ROLLBACK:
-- ALTER TABLE clients DROP COLUMN IF EXISTS website;
