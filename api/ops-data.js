// GPS Leadership — authenticated passthrough for the EA/ops "control" dashboard.
// control.html is password-gated, but the ops state tables are RLS-locked (anon access
// was revoked in the security lockdown), so the browser can no longer read them directly.
// This endpoint validates the control password server-side, then proxies a STRICT
// allowlist of ops tables using the service key. No other tables are reachable.
//
// Also supports:
//   op:'auth'            — server-side login check (no data returned)
//   op:'change-password' — self-service rotation of control_password (stored hashed)

const crypto = require('crypto');

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const ALLOW = /^\/rest\/v1\/(finance_state|ops_state|client_state|automation_settings|followups|reminders|scheduled_task_runs)(\?|$)/;

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

async function readControlCred() {
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/gps_settings?key=eq.control_password&select=value`,
    { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } });
  const rows = await pr.json();
  return rows && rows[0] ? rows[0].value : null;
}

// True if the supplied password matches the stored control credential.
// Supports a hashed value ({password_hash}) and legacy plaintext (string or {password}).
function checkControl(password, v) {
  if (!password || v == null) return false;
  if (typeof v === 'object') {
    if (v.password_hash) return sha256(password) === v.password_hash;
    if (v.password)      return password === v.password;
    return false;
  }
  return password === v;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok:false, status:405, data:{ error:'Method not allowed' } });
  if (!SUPABASE_SECRET)         return res.status(500).json({ ok:false, status:500, data:{ error:'Server not configured' } });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const password = body.password ? String(body.password) : '';
  const op       = body.op ? String(body.op) : 'proxy';
  const path     = body.path ? String(body.path) : '';
  const method   = (body.method ? String(body.method) : 'GET').toUpperCase();
  const fwdBody  = body.body != null ? body.body : null;
  const prefer   = body.prefer ? String(body.prefer) : null;

  // Validate the control password against gps_settings (server-side, service key).
  let cred = null;
  try { cred = await readControlCred(); } catch (_) { cred = null; }
  if (!checkControl(password, cred)) return res.status(401).json({ ok:false, status:401, data:{ error:'Unauthorized' } });

  // op:auth — login check only.
  if (op === 'auth') return res.status(200).json({ ok:true, status:200, data:{ ok:true } });

  // op:change-password — rotate control_password (stored hashed; never returned to the browser).
  if (op === 'change-password') {
    const np = body.newPassword != null ? String(body.newPassword) : '';
    if (np.length < 8) return res.status(400).json({ ok:false, status:400, data:{ error:'New password must be at least 8 characters' } });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/gps_settings?key=eq.control_password`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ value: { password_hash: sha256(np) }, updated_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: r.ok, status: r.status, data: { ok: r.ok } });
  }

  // proxy — strict allowlist + method guard.
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
