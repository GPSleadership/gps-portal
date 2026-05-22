-- Migration v12: Add completion_barrier column to checkins
-- Run this in Supabase SQL Editor before deploying the client.html changes.

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS completion_barrier text;

COMMENT ON COLUMN checkins.completion_barrier IS
  'Free-text explanation of what got in the way when completion_status is Partially or No.';
