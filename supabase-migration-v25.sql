-- Migration v25: Coaching portal URL on diagnostics
-- Stores the coaching client's portal URL directly on the diagnostic record.
-- Set by coach portal when markDebriefComplete() runs (if a coaching client is linked).
-- Read by diagnostic-leader.html to show the "Go to Your Coaching Portal" button
-- in Step 8 without needing a separate lookup.

ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS coaching_portal_url text;
