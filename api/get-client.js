// GPS Leadership — Secure Client Fetch + Portal Link Recovery
// GET  ?token=X          → returns client record + diagnostic prefill (if available)
// POST { email }         → looks up client by email, sends portal link via Resend
//
// v20 update: GET now also queries diagnostics table for wizard_prefill_data.
// If the client has a linked diagnostic with prefill data set, it is returned
// as client.diagnostic_prefill for the onboarding wizard to consume.
// Fails gracefully: if diagnostic query errors, client record still returns.

import crypto from 'node:crypto';

const SUPABASE_URL    = process.env.SUPABASE_URL        || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL   || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE     = process.env.PORTAL_BASE_URL     || 'https://portal.gpsleadership.org';
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const COACH_SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const COACH_ALERT_EMAIL    = process.env.COACH_ALERT_EMAIL || 'alex@gpsleadership.org';
const RESET_TTL_MS         = 15 * 60 * 1000; // password-reset code valid 15 min

function sbSecret(path, method = 'GET', body = null) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function buildResendLinkEmail(clientName, portalUrl) {
  const firstName = (clientName || '').split(' ')[0] || 'there';
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Portal Access Link</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        <p>Hi ${firstName},</p>
        <p>Here's your GPS Leadership Portal access link. Bookmark it so you always have it handy.</p>
        <div style="margin:28px 0;text-align:center;">
          <a href="${portalUrl}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Open My Portal →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${portalUrl}" style="color:#1A3D6E;">${portalUrl}</a></p>
        <p style="margin-top:24px;font-size:13px;color:#888;">Keep this link private — it's your personal access. If you didn't request this, you can ignore this email.</p>
        <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
      </div>
    </div>
  `;
}

// ── Coach auth helpers (Phase 1 hardening) ──────────────────────────────────
// Replaces the client-side plaintext password check in coach.html. Verifies a
// scrypt hash server-side (service key) and issues a signed, expiring session.
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig  = b64url(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifySession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = b64url(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest());
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}
function verifyPassword(password, stored) {
  // stored = "salt:hash" (scrypt 64-byte hex). Falls back to legacy plaintext
  // during the cutover transition; remove the plaintext path once hashes are set.
  if (!stored) return false;
  if (stored.includes(':')) {
    const [salt, hash] = stored.split(':');
    try {
      const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
      const a = Buffer.from(calc), b = Buffer.from(hash);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }
  return password === stored;
}
// ── Decision Room: email a sponsor their access link (coach-session gated) ──
function buildSponsorInviteEmail(name, url) {
  const first = name ? String(name).split(' ')[0] : 'there';
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;">'
    + '<h2 style="color:#004369;">Your Leadership Decision Room</h2>'
    + '<p>Hi ' + first + ',</p>'
    + '<p>Your GPS Leadership Decision Room is ready. It gives you a fast, current read on your leadership team — where they stand, what is already in motion, and the highest-leverage next moves.</p>'
    + '<p style="margin:24px 0;"><a href="' + url + '" style="background:#01949A;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;">Open your Decision Room</a></p>'
    + '<p style="font-size:12px;color:#666;">This private link is just for you. Please do not forward it.</p>'
    + '<p style="font-size:12px;color:#666;">— Alex Tremble, GPS Leadership Solutions</p></div>';
}
async function sponsorInvite(body, res) {
  const payload = verifySession(body.session);
  if (!payload || payload.role !== 'coach') return res.status(401).json({ error: 'Coach session invalid or expired' });
  if (!body.sponsor_id) return res.status(400).json({ error: 'sponsor_id required' });
  const r = await sbSecret(`/rest/v1/sponsors?id=eq.${encodeURIComponent(body.sponsor_id)}&select=name,email,sponsor_token&limit=1`);
  const rows = r.ok ? await r.json() : [];
  const sp = rows[0];
  if (!sp) return res.status(404).json({ error: 'Sponsor not found' });
  if (!sp.email) return res.status(400).json({ error: 'Sponsor has no email on file' });
  const url = `${PORTAL_BASE}/decision-room?token=${encodeURIComponent(sp.sponsor_token)}`;
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
        to: [sp.email],
        subject: 'Your GPS Leadership Decision Room',
        html: buildSponsorInviteEmail(sp.name, url),
      }),
    });
  }
  return res.status(200).json({ ok: true });
}
async function coachLogin(body, res) {
  if (!COACH_SESSION_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured — COACH_SESSION_SECRET missing' });
  }
  const password = body.password;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Prefer the hashed value; fall back to the legacy plaintext key in transition.
  let stored = null;
  const r = await sbSecret('/rest/v1/coach_settings?key=eq.coach_password_hash&select=value&limit=1');
  const rows = r.ok ? await r.json() : [];
  if (Array.isArray(rows) && rows[0]) stored = rows[0].value;
  if (!stored) {
    const r2 = await sbSecret('/rest/v1/coach_settings?key=eq.coach_password&select=value&limit=1');
    const rows2 = r2.ok ? await r2.json() : [];
    if (Array.isArray(rows2) && rows2[0]) stored = rows2[0].value;
  }

  let ok = verifyPassword(password, stored);
  if (!ok) {
    const ar = await sbSecret('/rest/v1/admin_accounts?is_active=eq.true&select=password');
    const admins = ar.ok ? await ar.json() : [];
    ok = Array.isArray(admins) && admins.some(a => verifyPassword(password, a.password));
  }
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  const session = signSession({ role: 'coach', exp: Date.now() + COACH_SESSION_TTL_MS });
  return res.status(200).json({ ok: true, session, expires_in_ms: COACH_SESSION_TTL_MS });
}
async function coachSession(body, res) {
  const payload = verifySession(body.session);
  if (!payload) return res.status(401).json({ ok: false });
  return res.status(200).json({ ok: true, role: payload.role, exp: payload.exp });
}

// ── Break-glass: email-gated coach password reset (works when locked out) ────
// A code is only ever emailed to the fixed COACH_ALERT_EMAIL, so this can't be
// abused to take over the account. Always returns ok (never reveals state).
async function upsertSetting(key, value) {
  return fetch(`${SUPABASE_URL}/rest/v1/coach_settings?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value: String(value), updated_at: new Date().toISOString() }),
  });
}
async function readSetting(key) {
  const r = await sbSecret(`/rest/v1/coach_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0].value : null;
}
function scryptHash(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(secret), salt, 64).toString('hex')}`;
}
function scryptVerify(secret, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const calc = crypto.scryptSync(String(secret), salt, 64).toString('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
async function coachResetRequest(res) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await upsertSetting('reset_code_hash', scryptHash(code));
  await upsertSetting('reset_code_expires', String(Date.now() + RESET_TTL_MS));
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
        to: [COACH_ALERT_EMAIL],
        subject: 'GPS Portal — coach dashboard reset code',
        html: `<p>Your coach dashboard reset code is <b style="font-size:20px">${code}</b>. It expires in 15 minutes.</p><p>If you didn't request this, ignore this email — your password is unchanged.</p>`,
      }),
    }).catch(() => {});
  }
  return res.status(200).json({ ok: true });
}
async function coachResetComplete(body, res) {
  const { code, new_password } = body;
  if (!code || !new_password) return res.status(400).json({ error: 'Code and new password required' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const storedHash = await readSetting('reset_code_hash');
  const expires    = parseInt((await readSetting('reset_code_expires')) || '0', 10);
  if (!storedHash || Date.now() > expires) return res.status(400).json({ error: 'Code expired — request a new one' });
  if (!scryptVerify(code, storedHash)) return res.status(401).json({ error: 'Incorrect code' });
  await upsertSetting('coach_password_hash', scryptHash(new_password));
  await upsertSetting('reset_code_hash', '');     // invalidate the used code
  await upsertSetting('reset_code_expires', '0');
  await upsertSetting('coach_password', '');       // clear any legacy plaintext
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured — missing secret key' });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};

    // Coach auth (Phase 1) — server-side hashed password + signed session.
    if (body.action === 'coach-login')          return coachLogin(body, res);
    if (body.action === 'coach-session')        return coachSession(body, res);
    if (body.action === 'coach-reset-request')  return coachResetRequest(res);
    if (body.action === 'coach-reset-complete') return coachResetComplete(body, res);
    if (body.action === 'sponsor-invite')       return sponsorInvite(body, res);

    // Default POST: portal link recovery
    const { email } = body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const r = await sbSecret(
        `/rest/v1/clients?email=eq.${encodeURIComponent(normalizedEmail)}&is_archived=eq.false&limit=1`
      );
      const clients = await r.json();

      // Always return success — never reveal whether an email exists
      if (!Array.isArray(clients) || clients.length === 0 || !clients[0].token) {
        return res.status(200).json({ ok: true });
      }

      const client = clients[0];
      const portalUrl = `${PORTAL_BASE}/client?token=${encodeURIComponent(client.token)}`;

      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
            to:      [client.email],
            subject: 'Your GPS Leadership Portal Link',
            html:    buildResendLinkEmail(client.name, portalUrl),
          }),
        });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[get-client/resend-link]', err);
      return res.status(200).json({ ok: true });
    }
  }

  // ── GET: fetch client by token ─────────────────────────────────────────────
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const clientRes = await sbSecret(
    `/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&limit=1`
  );

  if (!clientRes.ok) {
    const err = await clientRes.json();
    return res.status(500).json({ error: 'Database error', detail: err });
  }

  const clients = await clientRes.json();

  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const client = clients[0];

  if (client.in_coaching_program === false) {
    return res.status(403).json({ error: 'Access not available. Contact your coach.' });
  }

  // ── Diagnostic prefill lookup (v20) ────────────────────────────────────────
  // Only runs for clients who haven't submitted a plan yet (wizard path).
  // Wrapped in try/catch: if this fails, client record still returns normally.
  // The wizard handles null diagnostic_prefill gracefully (shows blank fields).
  if (!client.plan_submitted_at) {
    try {
      const diagRes = await sbSecret(
        `/rest/v1/diagnostics?client_id=eq.${encodeURIComponent(client.id)}&wizard_prefill_data=not.is.null&order=created_at.desc&limit=1&select=id,wizard_prefill_data,status`
      );

      if (diagRes.ok) {
        const diags = await diagRes.json();
        if (Array.isArray(diags) && diags.length > 0 && diags[0].wizard_prefill_data) {
          // Attach the prefill data to the client response
          // wizard_prefill_data structure: { key_theme, scores, suggested: { goal90, goal30, behavior1, behavior2, metric1, metric2, stakeholders } }
          client.diagnostic_prefill = diags[0].wizard_prefill_data;
          client.diagnostic_id_ref  = diags[0].id;
        }
      }
    } catch (diagErr) {
      // Non-blocking: log and continue. Wizard will show blank fields.
      console.error('[get-client/diagnostic-prefill]', diagErr.message || diagErr);
    }
  }

  return res.status(200).json(client);
}
