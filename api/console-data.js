// GPS Leadership — authenticated passthrough for the internal admin consoles
// (gps-executive-console[.|-deploy].html and gps-ea-console.html).
//
// These pages previously read/wrote gps_settings / gps_notes / gps_coach_uploads
// directly with the ANON key. Those tables' permissive anon policies are being
// revoked (security lockdown), so the browser can no longer reach them.
//
// This endpoint validates the console password SERVER-SIDE (service key), then
// proxies a STRICT allowlist of exactly those three tables. Secret keys in
// gps_settings (control_password, pw_hash, ea_console_settings, financial_strategy_note)
// are NEVER readable or writable through the generic passthrough — password changes
// go through the dedicated `change-password` op only.

const crypto = require('crypto');

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

// Only these three tables are reachable, and only via the paths the consoles use.
const TABLE_RE = /^\/rest\/v1\/(gps_settings|gps_notes|gps_coach_uploads)(\?|$)/;

// gps_settings keys that hold secrets — never exposed or written via passthrough.
const SECRET_KEYS = new Set(['control_password', 'pw_hash', 'ea_console_settings', 'financial_strategy_note']);
// Financial keys the EA role must never reach (only exec / master).
const EXEC_ONLY_KEYS = new Set(['accounts']);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` },
  });
  const txt = await r.text();
  try { return txt ? JSON.parse(txt) : null; } catch (_) { return txt; }
}

async function eaSettings() {
  const rows = await sbGet('/rest/v1/gps_settings?key=eq.ea_console_settings&select=value');
  let v = rows && rows[0] ? rows[0].value : null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = { password: v }; } }
  return v || {};
}

// Validate a console password. Returns false | 'exec' | 'ea' | 'master'.
// The exec credential (pw_hash) also works as a master override for the EA console,
// so there is no hardcoded master password in the browser anymore.
async function authenticate(role, password) {
  if (!password) return false;
  const execRows = await sbGet('/rest/v1/gps_settings?key=eq.pw_hash&select=value');
  const execStored = execRows && execRows[0] ? String(execRows[0].value).replace(/^"|"$/g, '') : null;
  const execMatch = !!execStored && sha256(password) === execStored;

  if (role === 'exec') return execMatch ? 'exec' : false;

  if (role === 'ea') {
    const v = await eaSettings();
    let eaMatch = false;
    if (v.password_hash) eaMatch = sha256(password) === v.password_hash;   // rotated (hashed)
    else if (v.password) eaMatch = password === v.password;                 // legacy (plaintext)
    if (eaMatch)  return 'ea';
    if (execMatch) return 'master';
    return false;
  }
  return false;
}

// Pull the gps_settings key targeted by a request (path filter or upsert body).
function settingsKeyFromPath(path) {
  const m = /[?&]key=eq\.([^&]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}
function settingsKeyFromBody(body) {
  try {
    const b = typeof body === 'string' ? JSON.parse(body) : body;
    if (Array.isArray(b)) return b.map(x => x && x.key).filter(Boolean);
    if (b && b.key) return [b.key];
  } catch (_) {}
  return [];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok: false, status: 405, data: { error: 'Method not allowed' } });
  if (!SUPABASE_SECRET)         return res.status(500).json({ ok: false, status: 500, data: { error: 'Server not configured' } });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const role     = body.role ? String(body.role) : '';
  const password = body.password != null ? String(body.password) : '';
  const op       = body.op ? String(body.op) : 'proxy';

  if (role !== 'exec' && role !== 'ea') {
    return res.status(400).json({ ok: false, status: 400, data: { error: 'Unknown role' } });
  }

  // Every op requires a valid password for the role.
  const authed = await authenticate(role, password);
  if (!authed) return res.status(401).json({ ok: false, status: 401, data: { error: 'Unauthorized' } });

  // ── op: auth — login check (+ first-login "must change" flag for EA) ──────
  if (op === 'auth') {
    let mustChange = false;
    if (role === 'ea' && authed === 'ea') {
      const v = await eaSettings();
      mustChange = v.passwordChanged !== true;
    }
    return res.status(200).json({ ok: true, status: 200, data: { ok: true, role: authed, mustChange } });
  }

  // ── op: change-password — server-side rotation, never via generic write ──
  if (op === 'change-password') {
    const newPassword = body.newPassword != null ? String(body.newPassword) : '';
    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, status: 400, data: { error: 'New password must be at least 8 characters' } });
    }
    const patch = async (key, value) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/gps_settings?key=eq.${key}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
      });
      return r.ok;
    };
    let ok = false;
    if (role === 'exec') {
      ok = await patch('pw_hash', sha256(newPassword));
    } else {
      ok = await patch('ea_console_settings', JSON.stringify({ password_hash: sha256(newPassword), passwordChanged: true }));
    }
    return res.status(200).json({ ok, status: ok ? 200 : 500, data: { ok } });
  }

  // ── op: proxy — strict allowlisted passthrough ───────────────────────────
  const path   = body.path ? String(body.path) : '';
  const method = (body.method ? String(body.method) : 'GET').toUpperCase();
  const fwd    = body.body != null ? body.body : null;
  const prefer = body.prefer ? String(body.prefer) : null;

  if (!TABLE_RE.test(path)) return res.status(403).json({ ok: false, status: 403, data: { error: 'Path not allowed' } });
  if (['GET', 'POST', 'PATCH', 'DELETE'].indexOf(method) === -1) {
    return res.status(405).json({ ok: false, status: 405, data: { error: 'Method not allowed' } });
  }

  // Guard gps_settings: block all access to secret keys, and never allow an
  // unfiltered read (which would dump every key, including secrets).
  if (/\/rest\/v1\/gps_settings/.test(path)) {
    const pathKey = settingsKeyFromPath(path);
    const bodyKeys = method === 'POST' || method === 'PATCH' ? settingsKeyFromBody(fwd) : [];
    const touched = [pathKey, ...bodyKeys].filter(Boolean);
    if (touched.some(k => SECRET_KEYS.has(k))) {
      return res.status(403).json({ ok: false, status: 403, data: { error: 'Key not allowed' } });
    }
    // EA role cannot reach financial keys; the exec password (master) can.
    if (authed === 'ea' && touched.some(k => EXEC_ONLY_KEYS.has(k))) {
      return res.status(403).json({ ok: false, status: 403, data: { error: 'Key not allowed for this role' } });
    }
    // A read with no key filter could leak secret keys — require a key filter on GET.
    if (method === 'GET' && !pathKey) {
      return res.status(403).json({ ok: false, status: 403, data: { error: 'Unfiltered gps_settings read not allowed' } });
    }
  }

  try {
    const headers = { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers,
      body: (method === 'GET' || fwd == null) ? undefined : (typeof fwd === 'string' ? fwd : JSON.stringify(fwd)),
    });
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (_) { data = txt; }

    // Defense in depth: strip any secret keys that slipped into a gps_settings response.
    if (Array.isArray(data)) data = data.filter(row => !(row && SECRET_KEYS.has(row.key)));

    return res.status(200).json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    return res.status(200).json({ ok: false, status: 500, data: { error: e.message } });
  }
};
