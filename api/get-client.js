// GPS Leadership — Secure Client Fetch + Portal Link Recovery
// GET  ?token=X          → returns client record (service role, server-side)
// POST { email }         → looks up client by email, sends portal link via Resend
// The service role key and Resend key never reach the browser.

const SUPABASE_URL    = process.env.SUPABASE_URL        || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL   || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE     = process.env.PORTAL_BASE_URL     || 'https://portal.gpsleadership.org';

function sbSecret(path, method = 'GET', body = null) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function buildResendLinkEmail(clientName, portalUrl) {
  const firstName = (clientName || '').split(' ')[0] || 'there';
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Portal Access Link</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        <p>Hi ${firstName},</p>
        <p>Here's your GPS Leadership Portal access link. Bookmark it so you always have it handy.</p>
        <div style="margin:28px 0;text-align:center;">
          <a href="${portalUrl}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Open My Portal →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${portalUrl}" style="color:#1A3D6E;">${portalUrl}</a></p>
        <p style="margin-top:24px;font-size:13px;color:#888;">Keep this link private — it's your personal access. If you didn't request this, you can ignore this email.</p>
        <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
      </div>
    </div>
  `;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured — missing secret key' });
  }

  // ── POST: portal link recovery ─────────────────────────────────────────
  if (req.method === 'POST') {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    try {
      // Look up client by email (case-insensitive)
      const r = await sbSecret(
        `/rest/v1/clients?email=eq.${encodeURIComponent(normalizedEmail)}&is_archived=eq.false&limit=1`
      );
      const clients = await r.json();

      // Always return success — never reveal whether an email exists
      if (!Array.isArray(clients) || clients.length === 0 || !clients[0].token) {
        return res.status(200).json({ ok: true });
      }

      const client = clients[0];
      const portalUrl = `${PORTAL_BASE}/client?token=${encodeURIComponent(client.token)}`;

      // Send via Resend if configured
      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
            to:      [client.email],
            subject: 'Your GPS Leadership Portal Link',
            html:    buildResendLinkEmail(client.name, portalUrl),
          }),
        });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      // Never expose internal errors on the recovery endpoint
      console.error('[get-client/resend-link]', err);
      return res.status(200).json({ ok: true });
    }
  }

  // ── GET: fetch client by token ─────────────────────────────────────────
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const clientRes = await sbSecret(
    `/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&limit=1`
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

  if (client.in_coaching_program === false) {
    return res.status(403).json({ error: 'Access not available. Contact your coach.' });
  }

  return res.status(200).json(client);
}
