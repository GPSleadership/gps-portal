// GPS Leadership — Coach Dashboard Data API (Phase 1 hardening, HYBRID model)
//
// Every request must carry a valid coach SESSION token (issued by
// /api/get-client?action=coach-login). With a valid session, the coach gets:
//   • a GENERIC allowlisted query proxy for ordinary dashboard tables, and
//   • DEDICATED hardened actions for the sensitive surface (settings that
//     aren't passwords, and admin_accounts management with hashed passwords).
//
// Password change / reset is handled separately in get-client.js (email-gated,
// works even when locked out). Report-PDF storage upload is hardened later in
// Step 5; the storage bucket policies are untouched by this file.
//
// POST /api/coach-data  { session, op?, table?, ... , action? }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

// ── Coach session verification (same HMAC scheme as get-client.js) ──────────
function verifyCoachSession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (!payload || payload.role !== 'coach' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Tables the dashboard may read through the generic proxy.
const READ_TABLES = new Set([
  'clients', 'checkins', 'sprints', 'sprint_closeouts', 'self_checks',
  'diagnostics', 'diagnostic_raters', 'diagnostic_responses',
  'diagnostic_report_drafts', 'diagnostic_question_overrides', 'diagnostic_team_reports',
  'stakeholders', 'survey_responses', 'survey_tokens',
  'ask_alex_usage', 'ask_alex_log', 'email_log', 'email_templates', 'client_errors',
  'testimonials', 'referrals',
  // Decision Room (v27)
  'teams', 'team_members', 'sponsors', 'sponsor_teams', 'recommendations', 'external_signals',
  // Workshop Module (v35)
  'workshops', 'workshop_participants', 'workshop_questions', 'workshop_responses',
  // Organizations (v40)
  'organizations',
]);
// Tables the dashboard may write through the generic proxy.
const WRITE_TABLES = new Set([
  'clients', 'checkins', 'sprints', 'sprint_closeouts',
  'diagnostics', 'diagnostic_raters', 'diagnostic_responses',
  'diagnostic_report_drafts', 'diagnostic_question_overrides', 'diagnostic_team_reports',
  'stakeholders', 'survey_responses', 'testimonials', 'referrals',
  // Decision Room (v27) — coach CRUD for teams, membership, recs, signals, sponsors
  'teams', 'team_members', 'sponsors', 'sponsor_teams', 'recommendations', 'external_signals',
  // Workshop Module (v35) — coach CRUD for workshops, participants, questions, responses
  'workshops', 'workshop_participants', 'workshop_questions', 'workshop_responses',
  // Organizations (v40)
  'organizations',
]);
// NOTE: admin_accounts and coach_settings are intentionally NOT in either set —
// they are served only by the dedicated, hardened actions below.

// Build a PostgREST query string from a structured, safe filter spec.
function buildQuery({ eq = {}, neq = {}, in: inF = {}, is = {}, gte = {}, lte = {}, ilike = {}, order, limit, select }) {
  const parts = [];
  for (const [c, v] of Object.entries(eq))   parts.push(`${encodeURIComponent(c)}=eq.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(neq))  parts.push(`${encodeURIComponent(c)}=neq.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(gte))  parts.push(`${encodeURIComponent(c)}=gte.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(lte))  parts.push(`${encodeURIComponent(c)}=lte.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(ilike))parts.push(`${encodeURIComponent(c)}=ilike.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(is))   parts.push(`${encodeURIComponent(c)}=is.${encodeURIComponent(v === null ? 'null' : v)}`);
  for (const [c, arr] of Object.entries(inF)) {
    const list = (Array.isArray(arr) ? arr : [arr]).map(x => encodeURIComponent(x)).join(',');
    parts.push(`${encodeURIComponent(c)}=in.(${list})`);
  }
  if (select) parts.push(`select=${encodeURIComponent(select)}`);
  if (order && order.col) parts.push(`order=${encodeURIComponent(order.col)}.${order.asc === false ? 'desc' : 'asc'}`);
  if (limit)  parts.push(`limit=${parseInt(limit, 10)}`);
  return parts.join('&');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body = req.body || {};

  // ── Gate: every coach-data request needs a valid coach session ────────────
  const session = verifyCoachSession(body.session);
  if (!session) return res.status(401).json({ error: 'Coach session invalid or expired' });

  // ── RBAC: owner (Alex) vs assistant (EA). Default owner for legacy sessions
  //    issued before lvl existed; new logins always carry lvl. ──────────────
  const lvl = session.lvl || 'owner';
  const isOwner = lvl === 'owner';
  const ownerOnly = () => res.status(403).json({ error: 'Owner-only action. Ask Alex to make this change.' });
  // Global IP / templates / automation: assistants may READ but never WRITE.
  const OWNER_ONLY_WRITE = new Set(['email_templates', 'coach_settings', 'diagnostic_question_overrides', 'workshop_questions']);
  // Permanent deletion of core records: owner only (assistants run ops, not nukes).
  const OWNER_ONLY_DELETE = new Set(['clients', 'diagnostics', 'teams', 'workshops', 'diagnostic_team_reports', 'diagnostic_raters', 'diagnostic_responses']);

  try {
    const action = body.action;

    // ── Dedicated: non-password settings ────────────────────────────────────
    if (action === 'get-setting') {
      const key = String(body.key || '');
      if (/password/i.test(key)) return res.status(403).json({ error: 'Forbidden setting' });
      const r = await sb(`/rest/v1/coach_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, value: rows[0] ? rows[0].value : null });
    }
    if (action === 'set-setting') {
      if (!isOwner) return ownerOnly();
      const key = String(body.key || '');
      if (/password/i.test(key)) return res.status(403).json({ error: 'Use password reset for credentials' });
      const r = await sb('/rest/v1/coach_settings?on_conflict=key', 'POST',
        { key, value: body.value, updated_at: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not save setting' });
      return res.status(200).json({ ok: true });
    }

    // ── Dedicated: admin_accounts (passwords always hashed) ─────────────────
    if (action === 'admin-list') {
      // Assistants may view the team list (read-only); only owners can modify it.
      const r = await sb('/rest/v1/admin_accounts?select=id,name,email,role,is_active,created_at&order=created_at.asc');
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, admins: rows, viewerLvl: lvl });  // never returns password
    }
    if (action === 'admin-add') {
      if (!isOwner) return ownerOnly();
      if (!body.name || !body.password) return res.status(400).json({ error: 'name and password required' });
      const role = (body.role === 'owner') ? 'owner' : 'assistant';
      const r = await sb('/rest/v1/admin_accounts', 'POST',
        { name: body.name, email: body.email ? String(body.email).toLowerCase() : null, password: hashPassword(body.password), notes: body.notes || null, role, is_active: true },
        { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add admin', detail: d }); }
      return res.status(200).json({ ok: true });
    }
    if (action === 'admin-update') {
      if (!isOwner) return ownerOnly();
      const patch = {};
      if (body.name  != null) patch.name = body.name;
      if (body.email != null) patch.email = String(body.email).toLowerCase();
      if (body.is_active != null) patch.is_active = !!body.is_active;
      if (body.role != null) patch.role = (body.role === 'owner') ? 'owner' : 'assistant';
      if (body.password) patch.password = hashPassword(body.password);
      const r = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}`, 'PATCH', patch, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not update admin' });
      return res.status(200).json({ ok: true });
    }
    if (action === 'admin-delete') {
      if (!isOwner) return ownerOnly();
      await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true });
    }
    // Owner emails an admin a freshly generated password (owner never sees it).
    if (action === 'admin-send-password') {
      if (!isOwner) return ownerOnly();
      const ar = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}&select=id,name,email&limit=1`);
      const rows = ar.ok ? await ar.json() : [];
      const acct = rows[0];
      if (!acct) return res.status(404).json({ error: 'Admin account not found' });
      if (!acct.email) return res.status(400).json({ error: 'This account has no email on file. Add one first.' });
      // Readable but strong: 3 word-like chunks + digits.
      const newPw = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
      const pr = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(acct.id)}`, 'PATCH',
        { password: hashPassword(newPw) }, { Prefer: 'return=minimal' });
      if (!pr.ok) return res.status(500).json({ error: 'Could not set the new password' });
      const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
      const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'alex@gpsleadership.org';
      if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured (RESEND_API_KEY missing)' });
      const first = (acct.name || 'there').split(' ')[0];
      const er = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM.includes('<') ? RESEND_FROM : `GPS Leadership <${RESEND_FROM}>`,
          to: [acct.email],
          subject: 'Your GPS Coach Dashboard access',
          html: '<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1a1a1a;">'
            + '<h2 style="color:#004369;">Your dashboard access</h2>'
            + `<p>Hi ${first},</p>`
            + '<p>You have access to the GPS Leadership coach dashboard. Here is your password:</p>'
            + `<p style="font-size:18px;font-weight:700;background:#f4f6f9;border-radius:8px;padding:12px 16px;letter-spacing:1px;">${newPw}</p>`
            + '<p>Log in here: <a href="https://portal.gpsleadership.org/coach">portal.gpsleadership.org/coach</a></p>'
            + '<p style="font-size:13px;color:#555;">Keep this somewhere safe (a password manager is best). If you ever need a new one, Alex can send a fresh password from the dashboard.</p>'
            + '<p style="font-size:13px;color:#555;">— GPS Leadership Solutions</p></div>',
        }),
      });
      if (!er.ok) return res.status(500).json({ error: 'Password was set but the email failed to send. Try again.' });
      return res.status(200).json({ ok: true, sent_to: acct.email });
    }

    // ── Generic allowlisted query proxy ─────────────────────────────────────
    const op    = body.op;
    const table = body.table;
    if (!op || !table) return res.status(400).json({ error: 'Missing op/table or unknown action' });

    if (op === 'select') {
      if (!READ_TABLES.has(table)) return res.status(403).json({ error: `Read not allowed: ${table}` });
      const qs = buildQuery(body);
      const r = await sb(`/rest/v1/${table}?${qs}`);
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Query failed', detail: d }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, rows, row: body.single ? (rows[0] || null) : undefined });
    }

    if (op === 'insert' || op === 'upsert') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && OWNER_ONLY_WRITE.has(table)) return ownerOnly();
      const path = op === 'upsert' && body.onConflict
        ? `/rest/v1/${table}?on_conflict=${encodeURIComponent(body.onConflict)}`
        : `/rest/v1/${table}`;
      const prefer = op === 'upsert' ? 'resolution=merge-duplicates,return=representation' : 'return=representation';
      const r = await sb(path, 'POST', body.values, { Prefer: prefer });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Write failed', detail: d }); }
      const rows = await r.json().catch(() => []);
      return res.status(200).json({ ok: true, rows });
    }

    if (op === 'update') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && OWNER_ONLY_WRITE.has(table)) return ownerOnly();
      // Assistants cannot unlock/edit auto-locked 90-day plans.
      if (!isOwner && (table === 'diagnostics' || table === 'clients') && body.values && /plan_status|plan_locked_at|plan_lock_source/.test(Object.keys(body.values).join(','))) return ownerOnly();
      const qs = buildQuery(body);
      if (!qs) return res.status(400).json({ error: 'Refusing unfiltered update' }); // never PATCH all rows
      const r = await sb(`/rest/v1/${table}?${qs}`, 'PATCH', body.values, { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Update failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    if (op === 'delete') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && (OWNER_ONLY_DELETE.has(table) || OWNER_ONLY_WRITE.has(table))) return ownerOnly();
      const qs = buildQuery(body);
      if (!qs) return res.status(400).json({ error: 'Refusing unfiltered delete' }); // never DELETE all rows
      const r = await sb(`/rest/v1/${table}?${qs}`, 'DELETE', null, { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Delete failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown op: ' + op });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
