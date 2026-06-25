-- v71: security S1 — drop anon write policies on diagnostic-reports storage bucket.
-- Applied to production 2026-06-24.
--
-- These granted the anon role INSERT + UPDATE on storage.objects for the
-- diagnostic-reports bucket, so anyone with the public key could upload or OVERWRITE
-- a client's report PDF. The legitimate upload flow uses service-role signed URLs
-- (api/diagnostic.js action=sign-report-upload -> uploadToSignedUrl), which bypass
-- RLS, so these policies were unnecessary. Reads are unaffected (the bucket is public).

drop policy if exists gps_diag_reports_insert on storage.objects;
drop policy if exists gps_diag_reports_update on storage.objects;

-- ROLLBACK (only if a non-signed-URL upload path is ever reintroduced — not recommended):
-- create policy gps_diag_reports_insert on storage.objects for insert to anon
--   with check (bucket_id = 'diagnostic-reports');
-- create policy gps_diag_reports_update on storage.objects for update to anon
--   using (bucket_id = 'diagnostic-reports');
