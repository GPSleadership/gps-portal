// GPS Leadership — authenticated passthrough for the EA/ops "control" dashboard.
// control.html is password-gated, but the ops state tables are RLS-locked (anon access
// was revoked in the security lockdown), so the browser can no longer read them directly.
// This endpoint validates the control password server-side, then proxies a STRICT
// allowlist of ops tables using the service key. No other tables are reachable.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const ALLOW = /^\/rest\/v1\/(finance_state|ops_state|client_state|automation_settings|followups|reminders|scheduled_task_runs)(\?|$)/;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok:false, status:405, data:{ error:'Method not allowed' } });
  if (!SUPABASE_SECRET)         return res.status(500).json({ ok:false, status:500, data:{ error:'Server not configured' } });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const password = body && body.password ? String(body.password) : '';
  const path     = body && body.path ? String(body.path) : '';
  const method   = (body && body.method ? String(body.method) : 'GET').toUpperCase();
  const fwdBody  = body && body.body != null ? body.body : null;
  const prefer   = body && body.prefer ? String(body.prefer) : null;

  // Validate the control password against gps_settings (server-side, service key).
  let authed = false;
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/gps_settings?key=eq.control_password&select=value`,
      { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } });
    const rows = await pr.json();
    const v = rows && rows[0] ? rows[0].value : null;
    const stored = v && (v.password || (typeof v === 'string' ? v : null));
    authed = !!stored && password === stored;
  } catch (_) { authed = false; }
  if (!authed) return res.status(401).json({ ok:false, status:401, data:{ error:'Unauthorized' } });

  // Strict allowlist + method guard.
  if (!ALLOW.test(path)) return res.status(403).json({ ok:false, status:403, data:{ error:'Path not allowed' } });
  if (['GET','POST','PATCH','DELETE'].indexOf(method) === -1) return res.status(405).json({ ok:false, status:405, data:{ error:'Method not allowed' } });

  try {
    const headers = { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type':'application/json' };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers,
      body: (method === 'GET' || fwdBody == null) ? undefined : (typeof fwdBody === 'string' ? fwdBody : JSON.stringify(fwdBody)),
    });
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (_) { data = txt; }
    return res.status(200).json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    return res.status(200).json({ ok:false, status:500, data:{ error: e.message } });
  }
};
