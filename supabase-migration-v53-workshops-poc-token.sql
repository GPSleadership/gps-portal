-- Migration v53: per-workshop POC access token. Applied to prod 2026-06-11. Additive.
-- Powers the progress-only Point-of-Contact view (/workshop-poc?token=...), which shows
-- participation/stage and lets the POC add participant emails — never scores or the report.
-- Mirrors workshops.sponsor_token.

ALTER TABLE workshops ADD COLUMN IF NOT EXISTS poc_token text;
UPDATE workshops SET poc_token = gen_random_uuid()::text WHERE poc_token IS NULL;
ALTER TABLE workshops ALTER COLUMN poc_token SET DEFAULT gen_random_uuid()::text;

-- ROLLBACK:
-- ALTER TABLE workshops DROP COLUMN IF EXISTS poc_token;
