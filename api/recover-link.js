// GPS Leadership — Self-service portal link recovery.
// A client who lost their portal link enters their email; if it matches an active
// client, we email them a fresh link (reusing the branded new_portal_link email).
// Enumeration-safe: every path returns the SAME generic response, so this endpoint
// can't be used to probe who is or isn't a client.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();

  // Identical response in every branch — never reveal whether the email exists.
  const generic = { ok: true, message: "If that email is on file, we've just sent a fresh portal link. Check your inbox (and your spam folder)." };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(200).json(generic);
  if (!SUPABASE_SECRET)                          return res.status(200).json(generic);

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(email)}&select=id,name,token,is_archived,portal_locked&limit=1`,
      { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } }
    );
    const rows = await r.json();
    const c = Array.isArray(rows) ? rows[0] : null;

    // Only send for a live account that actually has a token.
    if (c && c.token && !c.is_archived && !c.portal_locked) {
      const base = process.env.PORTAL_BASE_URL || ('https://' + (req.headers.host || 'portal.gpsleadership.org'));
      const portalURL = base + '?token=' + c.token;
      await fetch(base + '/api/notify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: 'new_portal_link', clientEmail: email, clientName: c.name, portalURL, clientId: c.id }),
      });
    }
  } catch (_) { /* swallow — the response must never differ based on outcome */ }

  return res.status(200).json(generic);
};
