// api/synthetic-check.js
// R4 golden-path synthetic monitor. Once a day (Vercel cron) this exercises the REAL
// client-facing read endpoints on production using a permanent, email-less synthetic
// account, and raises a P1 cio_findings if any critical path breaks — so we learn from
// a test, not from a real client hitting the break. Read-only: it never mutates data.
//
// Auth: Vercel cron header, or Bearer CRON_SECRET (manual trigger). No anon access.

const SUPABASE_URL    = process.env.SUPABASE_URL        || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const CRON_SECRET     = process.env.CRON_SECRET;
const SITE_URL        = process.env.SITE_URL            || 'https://portal.gpsleadership.org';
const SYNTH_TOKEN     = process.env.SYNTHETIC_TOKEN     || 'gps-synth-monitor-2026';

async function sbWrite(path, method, body) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
}

async function recordHeartbeat(name, status, detail) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeats?on_conflict=cron_name`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cron_name: name, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail, updated_at: new Date().toISOString() }),
    });
  } catch (_) { /* best-effort */ }
}

// One check: returns { name, ok, info }
async function check(name, fn) {
  try { const info = await fn(); return { name, ok: true, info: info || '' }; }
  catch (e) { return { name, ok: false, info: e.message || String(e) }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret    = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !hasSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const post = async (action) => {
    const r = await fetch(`${SITE_URL}/api/portal-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token: SYNTH_TOKEN }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(`${action} -> HTTP ${r.status} ${j.error || ''}`.trim());
    return `HTTP ${r.status}`;
  };

  const results = [];
  // 1) Login / load client (the get-client path every portal page depends on)
  results.push(await check('get-client', async () => {
    const r = await fetch(`${SITE_URL}/api/get-client?token=${encodeURIComponent(SYNTH_TOKEN)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || !j.id) throw new Error(`get-client -> HTTP ${r.status}`);
    return `client ${j.id ? 'ok' : 'missing'}`;
  }));
  // 2) Results tab data path
  results.push(await check('results-data', () => post('results-data')));
  // 3) Diagnostic data path
  results.push(await check('diag-get', () => post('diag-get')));
  // 4) Renewal/upsell money path — the endpoint that P0-2 silently broke. It now
  //    surfaces a DB failure (502) instead of swallowing it into show:false, so this
  //    check fails loudly if that class of bug ever returns. (2026-07-02)
  results.push(await check('renewal-options', () => post('renewal-options')));

  const failed = results.filter(r => !r.ok);
  const ok = failed.length === 0;

  // Raise (or refresh) a single P1 finding when any golden-path step breaks; resolve when healthy.
  if (!ok) {
    await sbWrite('cio_findings?on_conflict=dedupe_key', 'POST', {
      dedupe_key: 'synthetic:golden-path', category: 'reliability', severity: 'P1',
      title: 'Golden-path synthetic check failing',
      detail: 'Daily synthetic monitor failed: ' + failed.map(f => `${f.name} (${f.info})`).join('; ') + '. A core client-facing read path is broken on production.',
      recommendation: 'Reproduce the failing endpoint(s) with the synthetic token; check recent deploys, env vars, and Supabase status. This fired from a test, before a real client hit it.',
      source: 'synthetic-check', status: 'open', last_seen: new Date().toISOString(), first_seen: new Date().toISOString(),
    });
  } else {
    await sbWrite(`cio_findings?dedupe_key=eq.synthetic:golden-path&status=eq.open`, 'PATCH', {
      status: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  await recordHeartbeat('synthetic-check', ok ? 'ok' : 'fail', results.map(r => `${r.name}:${r.ok ? 'ok' : 'FAIL'}`).join(', '));
  return res.status(ok ? 200 : 503).json({ ok, results });
}
