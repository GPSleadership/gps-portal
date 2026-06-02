-- Migration v23: PDF report upload support
-- Adds report_pdf_url to diagnostics table
-- Creates diagnostic-reports storage bucket with public read / anon write policies

-- 1. Add column to diagnostics table
ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS report_pdf_url text;

-- 2. Create the storage bucket (public = true means files are publicly readable by URL)
INSERT INTO storage.buckets (id, name, public)
VALUES ('diagnostic-reports', 'diagnostic-reports', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage RLS policies
-- Allow anyone (anon) to upload/replace files — bucket is secured at the app level by coach password
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'gps_diag_reports_insert'
  ) THEN
    CREATE POLICY gps_diag_reports_insert ON storage.objects
      FOR INSERT TO anon
      WITH CHECK (bucket_id = 'diagnostic-reports');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'gps_diag_reports_update'
  ) THEN
    CREATE POLICY gps_diag_reports_update ON storage.objects
      FOR UPDATE TO anon
      USING (bucket_id = 'diagnostic-reports');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'gps_diag_reports_select'
  ) THEN
    CREATE POLICY gps_diag_reports_select ON storage.objects
      FOR SELECT TO public
      USING (bucket_id = 'diagnostic-reports');
  END IF;
END $$;
