// api/accept-terms.js
// Records Ask Alex Terms of Use consent for a client.
// Called when client checks the box and clicks "I Agree and Continue."

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

// Keep this in sync with CURRENT_TERMS_VERSION in client.html
const CURRENT_TERMS_VERSION = 'v1.0';

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
        ai_terms_version:     CURRENT_TERMS_VERSION,
        ai_terms_accepted_at: new Date().toISOString(),
      })
    }
  );

  if (!updateRes.ok) {
    const err = await updateRes.json();
    return res.status(500).json({ error: 'Failed to record consent', detail: err });
  }

  return res.status(200).json({ success: true, version: CURRENT_TERMS_VERSION });
}
