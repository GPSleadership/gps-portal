// GPS Leadership — Sponsor Hub API (read-only)
//
// One durable, revocable link per sponsor (a client) that lists EVERY workshop
// or assessment they sponsor. Resolves a hub_token (service-role lookup), finds
// the sponsor's workshops via the existing workshop_sponsors linkage, and returns
// a light list — title, date, status, the per-workshop sponsor token (to open the
// live dashboard), and the curated results page URL when one exists.
//
// Mirrors api/workshop-sponsor.js: service-role only, token-validated, no anon key,
// no per-participant data. Returns only what sponsor-hub.html renders.
//
// POST /api/sponsor-hub  { token }
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const token = (req.body || {}).token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // 1) Resolve the hub → sponsor (client). Reject revoked tokens.
    const hub = await sbOne(`/rest/v1/workshop_sponsor_hubs?hub_token=eq.${enc(token)}&select=id,client_id,org_name,revoked_at&limit=1`);
    if (!hub || hub.revoked_at) return res.status(401).json({ error: 'Invalid or expired link' });

    const client = await sbOne(`/rest/v1/clients?id=eq.${enc(hub.client_id)}&select=name,organization&limit=1`);
    const sponsorName = (client && client.name) || '';
    const orgName = hub.org_name || (client && client.organization) || '';

    // 2) This sponsor's workshops, via the per-sponsor linkage (each row carries
    //    its own access_token for the live dashboard).
    const links = await sbGet(`/rest/v1/workshop_sponsors?client_id=eq.${enc(hub.client_id)}&select=workshop_id,access_token`);

    const seen = {};
    const workshops = [];
    for (const link of links) {
      if (!link.workshop_id || seen[link.workshop_id]) continue;
      seen[link.workshop_id] = true;
      const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(link.workshop_id)}&select=title,client_org_name,workshop_date,debrief_date,status,engagement_kind,summary_approved,results_page_url&limit=1`);
      if (!w) continue;
      workshops.push({
        title: w.title || 'Workshop',
        org: w.client_org_name || orgName,
        date: w.workshop_date || null,
        debrief_date: w.debrief_date || null,
        status: w.status || '',
        kind: w.engagement_kind || 'workshop',
        approved: !!w.summary_approved,
        results_url: w.results_page_url || null,
        dashboard_token: link.access_token || null,
      });
    }

    // Newest first (null dates sink to the bottom).
    workshops.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return res.status(200).json({ ok: true, sponsor: { name: sponsorName, org: orgName }, workshops });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
