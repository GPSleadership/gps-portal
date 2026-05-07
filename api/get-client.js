// GPS Leadership — Secure Client Fetch
// Returns a single client record by token using the service role key.
// Called by client.html instead of querying Supabase directly.
// The service role key never reaches the browser.

const SUPABASE_URL    = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  if (!SUPABASE_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured — missing secret key' });
  }

  // Fetch client by token using service role key (bypasses RLS, server-side only)
  const clientRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&limit=1`,
    {
      headers: {
        apikey:        SUPABASE_SECRET,
        Authorization: `Bearer ${SUPABASE_SECRET}`,
        'Content-Type': 'application/json',
      },
    }
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

  // Only return clients who are in the coaching program
  if (client.in_coaching_program === false) {
    return res.status(403).json({ error: 'Access not available. Contact your coach.' });
  }

  // Strip sensitive coach-only fields before returning to client
  const {
    // Fields the client should NOT see:
    allow_plan_edit: _ape,
    // Return everything else
    ...safeClient
  } = client;

  return res.status(200).json(safeClient);
}
