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
