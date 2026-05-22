// api/email-templates.js
// Allows coach to save edits (subject, body_text, is_approved) to email templates.
// Auth: coach password or admin account password.

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
    const { template_key, subject, body_text, is_approved, password } = req.body;

    if (!template_key) return res.status(400).json({ error: 'template_key is required' });

    // Auth
    const authOk = await verifyPassword(password);
    if (!authOk) return res.status(401).json({ error: 'Invalid password' });

    // Build the update payload — only include fields that were provided
    const updates = { updated_at: new Date().toISOString() };
    if (subject    !== undefined) updates.subject    = subject;
    if (body_text  !== undefined) updates.body_text  = body_text;
    if (is_approved !== undefined) updates.is_approved = is_approved;

    const patchRes = await sbFetch(
      `/rest/v1/email_templates?template_key=eq.${encodeURIComponent(template_key)}`,
      'PATCH',
      updates,
      { 'Prefer': 'return=minimal' }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return res.status(500).json({ error: 'Failed to update template', detail: errText.slice(0, 300) });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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
