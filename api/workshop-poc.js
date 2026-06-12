// GPS Leadership — Workshop POC (point-of-contact) portal API.
// PROGRESS-ONLY: who has completed, how many, what stage. NEVER scores,
// aggregates, NPS/TP3, or the report. Also lets the POC add participant
// emails (pure logistics). Validated by the per-workshop poc_token.
//
// POST /api/workshop-poc  { token, action?, rows? }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function sbGet(path) { const r = await sb(path); if (!r.ok) return []; const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; }
async function sbOne(path) { return (await sbGet(path))[0] || null; }
function token48() { const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let t = ''; for (let i = 0; i < 48; i++) t += c[Math.floor(Math.random() * c.length)]; return t; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const body = req.body || {};
  const token = (body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing access link.' });

  // Validate the POC token → its workshop.
  const w = await sbOne(`/rest/v1/workshops?poc_token=eq.${enc(token)}&select=id,title,client_org_name,status,engagement_kind,workshop_date,debrief_date,roster_locked,roster_uploaded_at&limit=1`);
  if (!w) return res.status(401).json({ error: 'This link isn’t recognized. Please ask your GPS contact for a new one.' });

  const action = body.action || 'get';

  // ── Logistics: add participants by name + email (dedupe by email) ──────────
  if (action === 'upload-roster') {
    if (w.roster_locked) return res.status(403).json({ error: 'The participant list is locked. Please contact your GPS coach to make changes.' });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No valid rows — each person needs a name and an email.' });
    let created = 0, linked = 0, skipped = 0;
    for (const raw of rows) {
      const name = (raw.name || '').trim();
      const email = (raw.email || '').trim().toLowerCase();
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
      let client = await sbOne(`/rest/v1/clients?email=eq.${enc(email)}&select=id&limit=1`);
      if (!client) {
        const ins = await sb('/rest/v1/clients', 'POST', {
          name, email, title: raw.role || null, organization: w.client_org_name || null,
          is_workshop_participant: true, in_coaching_program: false, is_active: true,
        }, { Prefer: 'return=representation' });
        const cr = await ins.json().catch(() => []);
        client = Array.isArray(cr) ? cr[0] : cr;
        if (!client?.id) { skipped++; continue; }
        created++;
      }
      const link = await sb('/rest/v1/workshop_participants?on_conflict=workshop_id,client_id', 'POST', {
        workshop_id: w.id, client_id: client.id, role: raw.role || null,
        department: raw.department || null, location: raw.location || null, participant_token: token48(),
      }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (link.ok) linked++; else skipped++;
    }
    await sb(`/rest/v1/workshops?id=eq.${enc(w.id)}`, 'PATCH', { roster_uploaded_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    return res.status(200).json({ ok: true, created, linked, skipped });
  }

  // ── Default: progress-only payload (no scores anywhere) ───────────────────
  const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(w.id)}&select=client_id,pre_status,invited_at&order=created_at.asc`);
  const participants = await Promise.all(parts.map(async p => {
    const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
    return { name: c?.name || '', email: c?.email || '', completed: p.pre_status === 'complete', invited: !!p.invited_at };
  }));
  const total = participants.length;
  const completed = participants.filter(p => p.completed).length;
  const invited = participants.filter(p => p.invited).length;

  let orgLogo = null;
  if (w.client_org_name) {
    const o = await sbOne(`/rest/v1/organizations?name=eq.${enc(w.client_org_name)}&select=logo_url&limit=1`);
    if (o && o.logo_url) orgLogo = o.logo_url;
  }

  return res.status(200).json({
    ok: true,
    workshop: {
      title: w.title, org: w.client_org_name || '', status: w.status, kind: w.engagement_kind,
      workshop_date: w.workshop_date, debrief_date: w.debrief_date,
      roster_locked: !!w.roster_locked, org_logo_url: orgLogo,
    },
    counts: { total, completed, invited, pending: total - completed },
    participants,
  });
}
