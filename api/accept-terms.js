// api/accept-terms.js
// Records Ask Alex Terms of Use consent for a client.
// Called when client checks the box and clicks "I Agree and Continue."

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

// P0-6 (Wave 2, 3A): the acceptance version is now sourced from legal_texts (key:
// system_entry_ack) — the single source of truth — instead of a hardcoded string.
// Falls back to 'v1.0' if no active row exists, so a sign-in never fails on this.
const FALLBACK_TERMS_VERSION = 'v1.0';
async function activeSystemEntryVersion() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/legal_texts?key=eq.system_entry_ack&is_active=eq.true&select=version&limit=1`,
      { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } }
    );
    if (!r.ok) return FALLBACK_TERMS_VERSION;
    const rows = await r.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].version) ? rows[0].version : FALLBACK_TERMS_VERSION;
  } catch (_) { return FALLBACK_TERMS_VERSION; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured — missing secret key' });
  }

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const version = await activeSystemEntryVersion();

  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?token=eq.${encodeURIComponent(token)}`,
    {
      method: 'PATCH',
      headers: {
        apikey:         SUPABASE_SECRET,
        Authorization:  `Bearer ${SUPABASE_SECRET}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
      },
      body: JSON.stringify({
        ai_terms_accepted:    true,
        ai_terms_version:     version,
        ai_terms_accepted_at: new Date().toISOString(),
      })
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    return res.status(500).json({ error: 'Failed to record consent', detail: err });
  }

  return res.status(200).json({ success: true, version });
}
