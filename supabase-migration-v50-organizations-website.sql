-- Migration v50: organizations.website (optional). Applied to prod 2026-06-10. Additive.
-- Why: standalone Add/Edit Organization flow (from the home "+ Add" menu) now captures
-- name, website, industry, size band, logo URL, and notes. org-create/org-update in
-- api/workshop-data.js handle the website field.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website text;

-- ROLLBACK:
-- ALTER TABLE organizations DROP COLUMN IF EXISTS website;
