-- Migration v51: point-of-contact fields on a Decision Room team. Applied to prod 2026-06-10. Additive.
-- Why: a team needs a logistics contact (POC) who is NOT a sponsor — recorded only,
-- no portal access, no results, no email. Added a "Point of contact" card on the team page.

ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_name  text;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_email text;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_phone text;

-- ROLLBACK:
-- ALTER TABLE teams DROP COLUMN IF EXISTS poc_name, DROP COLUMN IF EXISTS poc_email, DROP COLUMN IF EXISTS poc_phone;
