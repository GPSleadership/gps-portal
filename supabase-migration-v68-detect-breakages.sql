-- v68: detect_breakages() — turns portal breakages into cio_findings
-- Applied to production 2026-06-24. Additive only (new function; no schema changes).
--
-- Scans the last 24h of email_log (delivery failures) and client_errors (recurring
-- JS errors) and upserts one open cio_findings row per distinct issue (deduped by
-- dedupe_key). The daily brief already reads cio_findings and surfaces P0/P1; the CIO
-- skill triages open findings. Called by api/ops-monitor.js on a Vercel cron.
-- Recurrence of a previously-resolved issue re-opens the finding.

create or replace function detect_breakages()
returns jsonb language plpgsql security definer as $$
declare
  rec record;
  email_groups int := 0;
  error_groups int := 0;
begin
  -- 1) Email delivery failures in the last 24h, grouped by email_type
  for rec in
    select email_type,
           count(*) as n,
           max(sent_at) as last_at,
           (array_agg(distinct recipient_email))[1:5] as samples,
           (array_agg(error_details order by sent_at desc))[1] as sample_err
    from email_log
    where status = 'error' and sent_at > now() - interval '24 hours'
    group by email_type
  loop
    email_groups := email_groups + 1;
    insert into cio_findings (dedupe_key, category, severity, title, detail, recommendation, source, status, first_seen, last_seen)
    values (
      'email_fail:' || rec.email_type,
      'reliability', 'P2',
      'Email failing to send: ' || rec.email_type,
      rec.n || ' "' || rec.email_type || '" email(s) failed in the last 24h. Recipients incl: '
        || array_to_string(rec.samples, ', ') || '. Last error: ' || left(coalesce(rec.sample_err,''), 200),
      'Check the sender from-address / Resend domain verification and email_log.error_details. After fixing, re-send via the coach dashboard (Run Reminders Now).',
      'ops-monitor', 'open', now(), now()
    )
    on conflict (dedupe_key) do update set
      last_seen   = now(),
      detail      = excluded.detail,
      severity    = excluded.severity,
      updated_at  = now(),
      status      = case when cio_findings.status = 'resolved' then 'open' else cio_findings.status end,
      resolved_at = case when cio_findings.status = 'resolved' then null else cio_findings.resolved_at end;
  end loop;

  -- 2) Recurring client-side JS errors in the last 24h (ignore one-offs: require >= 3)
  for rec in
    select left(coalesce(message,'(no message)'),120) as msg,
           count(*) as n, max(occurred_at) as last_at,
           (array_agg(distinct page))[1:3] as pages
    from client_errors
    where occurred_at > now() - interval '24 hours'
    group by left(coalesce(message,'(no message)'),120)
    having count(*) >= 3
  loop
    error_groups := error_groups + 1;
    insert into cio_findings (dedupe_key, category, severity, title, detail, recommendation, source, status, first_seen, last_seen)
    values (
      'client_err:' || md5(rec.msg),
      'reliability', 'P2',
      'Recurring client JS error: ' || rec.msg,
      rec.n || ' occurrences in last 24h on page(s): ' || array_to_string(rec.pages, ', ') || '. Message: ' || rec.msg,
      'Inspect client_errors stack traces; reproduce on the affected page and fix the JS.',
      'ops-monitor', 'open', now(), now()
    )
    on conflict (dedupe_key) do update set
      last_seen   = now(),
      detail      = excluded.detail,
      updated_at  = now(),
      status      = case when cio_findings.status = 'resolved' then 'open' else cio_findings.status end,
      resolved_at = case when cio_findings.status = 'resolved' then null else cio_findings.resolved_at end;
  end loop;

  return jsonb_build_object('ok', true, 'checked_at', now(), 'email_failure_types', email_groups, 'client_error_types', error_groups);
end$$;

revoke all on function detect_breakages() from public, anon, authenticated;
grant execute on function detect_breakages() to service_role;

-- ROLLBACK
-- drop function if exists detect_breakages();
