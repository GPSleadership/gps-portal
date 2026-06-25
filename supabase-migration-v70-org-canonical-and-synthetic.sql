-- v70: R3 org-canonical backfill + R4 synthetic monitor — applied to production 2026-06-24.
-- Data + seed migration (no schema changes).
--
-- R3: `organization` is the canonical company column (every read uses it); `org` was a
-- drift column the client profile-save wrote to while reads expected `organization`.
-- Backfill organization from org only where organization was empty (never overwrite a
-- real value). Code now writes `organization` (client.html + portal-data CLIENT_WRITABLE).
update clients set organization = org
where (organization is null or organization = '') and org is not null and org <> '';

-- R4: permanent, email-less synthetic monitor account. The daily api/synthetic-check
-- cron exercises the real client read paths (get-client, results-data, diag-get) with
-- this token and raises a P1 cio_findings if any break. email is NULL so it never
-- receives automated mail; not enrolled so it stays out of coaching flows.
insert into clients (id, name, email, token, organization, account_type, in_coaching_program, is_active, is_archived)
values ('44444444-4444-4444-8444-444444444444', 'ZZZ Synthetic Monitor (do not delete)',
        null, 'gps-synth-monitor-2026', 'GPS Internal', 'client', false, true, false)
on conflict (id) do nothing;

insert into cron_heartbeats (cron_name, expected_interval_minutes, last_run_at)
values ('synthetic-check', 1440, now())
on conflict (cron_name) do update set expected_interval_minutes = excluded.expected_interval_minutes;

-- ROLLBACK
-- delete from clients where id='44444444-4444-4444-8444-444444444444';
-- delete from cron_heartbeats where cron_name='synthetic-check';
-- (org backfill is not reversed — organization is canonical)
