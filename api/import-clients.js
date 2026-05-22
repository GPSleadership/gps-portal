// GPS Leadership — Bulk Client Import
// Receives an array of client records parsed from Excel/CSV in the browser.
// Uses the service role key to insert all records server-side.
// Each client gets a unique token generated server-side.

const SUPABASE_URL    = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
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

  const { clients } = req.body;

  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'No clients provided' });
  }

  if (clients.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 clients per import' });
  }

  // Build records — name and email required, rest optional
  const records = [];
  const skipped = [];

  for (const row of clients) {
    const name  = (row.name  || row.Name  || '').toString().trim();
    const email = (row.email || row.Email || '').toString().trim();

    if (!name || !email) {
      skipped.push({ row, reason: 'Missing name or email' });
      continue;
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped.push({ row, reason: 'Invalid email format' });
      continue;
    }

    records.push({
      name,
      email,
      title:        (row.title        || row.Title        || '').toString().trim() || null,
      organization: (row.organization || row.Organization || row.org || row.Org || '').toString().trim() || null,
      industry:     (row.industry     || row.Industry     || '').toString().trim() || null,
      revenue_band: (row.revenue_band || row.Revenue      || '').toString().trim() || null,
      token:        generateToken(),
      is_active:    true,
      in_coaching_program: true,
    });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'No valid clients to import', skipped });
  }

  // Bulk insert using service role key
  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients`,
    {
      method: 'POST',
      headers: {
        apikey:         SUPABASE_SECRET,
        Authorization:  `Bearer ${SUPABASE_SECRET}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
      },
      body: JSON.stringify(records),
    }
  );

  if (!insertRes.ok) {
    const err = await insertRes.json();
    return res.status(500).json({ error: 'Import failed', detail: err });
  }

  const inserted = await insertRes.json();

  return res.status(200).json({
    success:  true,
    imported: inserted.length,
    skipped:  skipped.length > 0 ? skipped : undefined,
    clients:  inserted,
  });
}
