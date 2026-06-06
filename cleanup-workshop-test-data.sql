-- Cleanup: remove ALL workshop-module TEST/DEMO seed rows.
-- FK-safe order. Run in the Supabase SQL editor when you want a clean slate.
-- SAFE: only touches rows named 'TEST %' / 'DEMO %' or with demo-* emails.
-- Does NOT touch real accounts (e.g., Su Nu) — only her demo workshop is removed;
-- her client profile and her workshop_participants link cascade-clean automatically.

-- Detach testimonials/referrals tied to demo people (set null already on workshop delete,
-- but remove any demo-sourced ones explicitly).
DELETE FROM testimonials WHERE client_id IN (SELECT id FROM clients WHERE name LIKE 'TEST %' OR name LIKE 'DEMO %' OR email LIKE 'demo-%');
DELETE FROM referrals    WHERE referrer_client_id IN (SELECT id FROM clients WHERE name LIKE 'TEST %' OR name LIKE 'DEMO %' OR email LIKE 'demo-%');

-- Deleting the workshop cascades its participants, questions, and responses.
DELETE FROM workshops WHERE title LIKE 'TEST %' OR title LIKE 'DEMO:%';

-- Remove demo people (participants + the two fake sponsors). Real accounts are untouched.
DELETE FROM clients WHERE name LIKE 'TEST %' OR name LIKE 'DEMO %' OR email LIKE 'demo-%';

SELECT 'TEST/DEMO workshop data removed' AS status;
