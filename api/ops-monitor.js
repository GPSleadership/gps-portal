// api/ops-monitor.js
// Breakage detector. Runs on a Vercel cron; calls the detect_breakages() SQL
// function (service role) which scans the last 24h of email_log delivery failures
// and recurring client_errors and upserts them into cio_findings. The daily brief
// already reads cio_findings and surfaces P0/P1; the CIO skill triages open items.
// So: anything that breaks -> lands in the ledger -> brief flags it -> CIO triages.
//
// Auth: Vercel cron header, or Bearer CRON_SECRET (for manual trigger). No anon access.

const SUPABASE_URL    = process.env.SUPABASE_URL        || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const CRON_SECRET     = process.env.CRON_SECRET;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
// FROM domain pinned (same rule as the other senders): only gpsleadership.org.
const RESEND_FROM     = /@(?:[a-z0-9-]+\.)*gpsleadership\.org$/i.test(String(process.env.RESEND_FROM_EMAIL || ''))
  ? process.env.RESEND_FROM_EMAIL
  : 'noreply@portal.gpsleadership.org';
const COACH_EMAIL     = process.env.COACH_ALERT_EMAIL || 'alex@gpsleadership.org';

// Record a successful cron run so detect_breakages can flag a job that goes silent.
async function recordHeartbeat(name, status = 'ok', detail = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeats?on_conflict=cron_name`, {
      method:  'POST',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cron_name: name, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail, updated_at: new Date().toISOString() }),
    });
  } catch (_) { /* heartbeat is best-effort; never fail the run on it */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret    = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !hasSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing service key' });

  // ── ACTION: p2-digest — weekly roll-up of open P2 findings (5G) ─────────────
  // detect_breakages files everything at P2, but the daily brief surfaces only
  // P0/P1 — so P2 issues (failing email types, recurring client JS errors) never
  // reached Alex at all. This weekly digest (Monday cron) emails the open P2 list
  // once a week: visible without spamming P2 noise into the daily P0/P1 alert.
  if ((req.query && req.query.action) === 'p2-digest') {
    try {
      const fr = await fetch(`${SUPABASE_URL}/rest/v1/cio_findings?severity=eq.P2&status=eq.open&select=title,detail,category,first_seen,last_seen&order=last_seen.desc&limit=40`, {
        headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` },
      });
      const findings = fr.ok ? await fr.json() : [];
      const n = Array.isArray(findings) ? findings.length : 0;
      if (n === 0) {
        await recordHeartbeat('p2-digest', 'ok', 'no open P2 findings');
        return res.status(200).json({ ok: true, open_p2: 0, emailed: false });
      }
      const fmtD = (d) => d ? String(d).slice(0, 10) : '?';
      const rows = findings.map(f =>
        '<tr>'
        + `<td style="padding:9px 12px;border-bottom:1px solid #e8e4dc;font-size:13px;font-weight:700;color:#1a2a3a;">${String(f.title || '').replace(/</g, '&lt;')}</td>`
        + `<td style="padding:9px 12px;border-bottom:1px solid #e8e4dc;font-size:12px;color:#555;">${String(f.detail || '').replace(/</g, '&lt;').slice(0, 180)}</td>`
        + `<td style="padding:9px 12px;border-bottom:1px solid #e8e4dc;font-size:11px;color:#888;white-space:nowrap;">${fmtD(f.first_seen)} &rarr; ${fmtD(f.last_seen)}</td>`
        + '</tr>'
      ).join('');
      const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:18px 24px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership — Weekly Ops Digest</div>
          <div style="color:#ffffff;font-size:19px;font-weight:700;">${n} open P2 item${n !== 1 ? 's' : ''} worth a look</div>
        </div>
        <div style="background:#ffffff;padding:22px 24px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;">
          <p style="margin:0 0 14px;font-size:14px;line-height:1.6;">These are not urgent (P0/P1 items alert daily), but they are real: each one is a detected breakage or recurring error that stays open until fixed. Ten minutes on the worst of these keeps them from becoming next month's P1.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
            <thead><tr style="background:#f5f3ee;">
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#666;">Finding</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#666;">Detail</th>
              <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#666;">Seen</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:0;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;">Sent weekly (Mondays) while open P2 findings exist. Source: cio_findings via detect_breakages().</p>
        </div>
      </div>`;
      let emailed = false;
      if (RESEND_API_KEY) {
        const er = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `GPS Leadership Portal <${RESEND_FROM}>`,
            to: [COACH_EMAIL],
            subject: `Weekly ops digest — ${n} open P2 item${n !== 1 ? 's' : ''}`,
            html,
            text: findings.map(f => `${f.title}: ${String(f.detail || '').slice(0, 160)}`).join('\n'),
          }),
        });
        emailed = er.ok;
      }
      await recordHeartbeat('p2-digest', 'ok', `${n} open P2, emailed=${emailed}`);
      return res.status(200).json({ ok: true, open_p2: n, emailed });
    } catch (e) {
      await recordHeartbeat('p2-digest', 'error', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/detect_breakages`, {
      method:  'POST',
      headers: {
        apikey:         SUPABASE_SECRET,
        Authorization:  `Bearer ${SUPABASE_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'detect_breakages failed', detail: data });
    await recordHeartbeat('ops-monitor');
    return res.status(200).json({ ok: true, result: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
