// api/start-sprint.js
// Starts a new sprint for a client.
// Creates a record in the sprints table, increments clients.current_sprint_number,
// marks the previous sprint as 'complete', and optionally sets new behavior_focus.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { client_id, behavior_focus, start_date, password } = req.body;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    // Auth: coach session (preferred) or legacy password (transition fallback)
    const authOk = !!verifyCoachSession(req.body.session);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    // ── Load current client ───────────────────────────────────────────────────
    const clientRes = await sbFetch(
      `/rest/v1/clients?id=eq.${client_id}&select=id,name,current_sprint_number,closeout_submitted_at`
    );
    if (!clientRes.ok) return res.status(500).json({ error: 'Failed to load client' });
    const clients = await clientRes.json();
    if (!clients || clients.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];

    const currentSprintNum = client.current_sprint_number || 1;
    const newSprintNum     = currentSprintNum + 1;
    const sprintStartDate  = start_date || new Date().toISOString().split('T')[0];

    // ── Close current sprint ──────────────────────────────────────────────────
    await sbFetch(
      `/rest/v1/sprints?client_id=eq.${client_id}&sprint_number=eq.${currentSprintNum}`,
      'PATCH',
      { status: 'complete', end_date: sprintStartDate },
      { 'Prefer': 'return=minimal' }
    );

    // ── Create new sprint record ──────────────────────────────────────────────
    const insertRes = await sbFetch('/rest/v1/sprints', 'POST', {
      client_id,
      sprint_number:  newSprintNum,
      start_date:     sprintStartDate,
      behavior_focus: behavior_focus || null,
      status:         'active'
    }, { 'Prefer': 'return=minimal' });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(500).json({ error: 'Failed to create sprint', detail: errText.slice(0, 200) });
    }

    // ── Increment client's current_sprint_number ──────────────────────────────
    await sbFetch(
      `/rest/v1/clients?id=eq.${client_id}`,
      'PATCH',
      {
        current_sprint_number:  newSprintNum,
        closeout_submitted_at:  null  // reset for new sprint
      },
      { 'Prefer': 'return=minimal' }
    );

    // ── Also create sprint 1 record if it didn't exist ────────────────────────
    // (ensures existing clients have a record for sprint 1)
    const sprint1Res = await sbFetch(
      `/rest/v1/sprints?client_id=eq.${client_id}&sprint_number=eq.${currentSprintNum}&select=id`
    );
    const sprint1Data = sprint1Res.ok ? await sprint1Res.json() : [];
    if (!sprint1Data || sprint1Data.length === 0) {
      await sbFetch('/rest/v1/sprints', 'POST', {
        client_id,
        sprint_number:  currentSprintNum,
        start_date:     null,
        status:         'complete'
      }, { 'Prefer': 'return=minimal' });
    }

    return res.status(200).json({ success: true, new_sprint_number: newSprintNum });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

import crypto from 'node:crypto';
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
// Preferred auth: HMAC coach session (replaces the password read in the browser).
function verifyCoachSession(tok) {
  if (!tok || !COACH_SESSION_SECRET) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!p || p.role !== 'coach' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

async function verifyPassword(password) {
  if (!password) return false;
  const settingsRes = await sbFetch('/rest/v1/coach_settings?key=eq.coach_password&select=value&limit=1');
  if (settingsRes.ok) {
    const settings = await settingsRes.json();
    if (settings && settings[0] && settings[0].value === password) return true;
  }
  const adminRes = await sbFetch('/rest/v1/admin_accounts?is_active=eq.true&select=password');
  if (adminRes.ok) {
    const admins = await adminRes.json();
    if ((admins || []).map(a => a.password).includes(password)) return true;
  }
  return false;
}

function sbFetch(path, method = 'GET', body = null, extraHeaders = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
}
