// GPS Leadership — Bulk Client Import
// Receives an array of client records parsed from Excel/CSV in the browser.
// Uses the service role key to insert all records server-side.
// Each client gets a unique token generated server-side.

import crypto from 'crypto';

const SUPABASE_URL    = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

// Same HMAC-signed coach session used by api/coach-data.js.
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

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(48);
  let token = '';
  for (let i = 0; i < 48; i++) token += chars[bytes[i] % chars.length];
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

  // Coach-only: this endpoint writes client records with the service-role key.
  if (!verifyCoachSession(req.body && req.body.session)) {
    return res.status(401).json({ error: 'Coach authentication required' });
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
      phone:        (row.phone        || row.Phone        || '').toString().trim() || null,
      token:        generateToken(),
      is_active:    true,
      in_coaching_program: false,
    });
  }

  // Skip anyone who already exists (by email) so re-importing an overlapping list never duplicates.
  if (records.length) {
    try {
      const emailIn = records.map(r => `"${r.email}"`).join(',');
      const existRes = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=email&email=in.(${emailIn})`, {
        headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` },
      });
      if (existRes.ok) {
        const existing = await existRes.json().catch(() => []);
        const have = new Set((existing || []).map(c => String(c.email || '').toLowerCase()));
        for (let i = records.length - 1; i >= 0; i--) {
          if (have.has(String(records[i].email).toLowerCase())) {
            skipped.push({ row: records[i], reason: 'Already exists — skipped to avoid a duplicate' });
            records.splice(i, 1);
          }
        }
      }
    } catch (_) { /* if the check fails, fall through to insert */ }
  }

  const existedCount = skipped.filter(s => /already exists/i.test(s.reason)).length;
  const invalidCount = skipped.length - existedCount;

  if (records.length === 0) {
    // Not an error — most commonly everyone on the list is already a client.
    return res.status(200).json({
      success:       true,
      imported:      0,
      already_exist: existedCount,
      invalid:       invalidCount,
      skipped,
    });
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
    success:       true,
    imported:      inserted.length,
    already_exist: existedCount,
    invalid:       invalidCount,
    skipped:       skipped.length > 0 ? skipped : undefined,
    clients:       inserted,
  });
}
