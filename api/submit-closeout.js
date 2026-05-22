// api/submit-closeout.js
// Handles the 90-day closeout form submission from the client portal.
// Saves responses to sprint_closeouts, stamps clients.closeout_submitted_at,
// and emails Alex if the client requests a next sprint or ongoing coaching.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const FROM_EMAIL      = 'alex@gpsleadership.org';
const FROM_NAME       = 'Alex Tremble | GPS Leadership Solutions';
const ALEX_EMAIL      = 'alex@gpsleadership.org';

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
    const {
      client_id,
      client_token,       // used to verify identity (token in URL)
      sprint_number = 1,
      q1_response,
      q2_response,
      is_coaching_client,
      next_sprint_requested
    } = req.body;

    if (!client_id)  return res.status(400).json({ error: 'client_id is required' });
    if (!client_token) return res.status(400).json({ error: 'client_token is required' });

    // ── Verify client token ───────────────────────────────────────────────────
    const clientRes = await sbFetch(
      `/rest/v1/clients?id=eq.${client_id}&token=eq.${encodeURIComponent(client_token)}&select=id,name,email`
    );
    if (!clientRes.ok) return res.status(500).json({ error: 'Failed to verify client' });
    const clients = await clientRes.json();
    if (!clients || clients.length === 0) return res.status(403).json({ error: 'Invalid client token' });
    const client = clients[0];

    // ── Check for existing closeout ───────────────────────────────────────────
    const existingRes = await sbFetch(
      `/rest/v1/sprint_closeouts?client_id=eq.${client_id}&sprint_number=eq.${sprint_number}&select=id`
    );
    const existing = existingRes.ok ? await existingRes.json() : [];
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Closeout already submitted for this sprint' });
    }

    // ── Save closeout responses ───────────────────────────────────────────────
    const insertRes = await sbFetch('/rest/v1/sprint_closeouts', 'POST', {
      client_id,
      sprint_number,
      q1_response:          q1_response           || null,
      q2_response:          q2_response           || null,
      is_coaching_client:   !!is_coaching_client,
      next_sprint_requested: !!next_sprint_requested
    }, { 'Prefer': 'return=minimal' });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(500).json({ error: 'Failed to save closeout', detail: errText.slice(0, 200) });
    }

    // ── Stamp closeout_submitted_at on client record ───────────────────────────
    await sbFetch(
      `/rest/v1/clients?id=eq.${client_id}`,
      'PATCH',
      { closeout_submitted_at: new Date().toISOString() },
      { 'Prefer': 'return=minimal' }
    );

    // ── Notify Alex if next sprint requested ──────────────────────────────────
    if (next_sprint_requested) {
      const subject = `[GPS] ${client.name} has requested a next sprint`;
      const html    = buildAlexNotificationHtml(client, q1_response, q2_response, is_coaching_client);
      await sendEmail(ALEX_EMAIL, subject, html, client_id, client.name, 'closeout_next_sprint_request');
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAlexNotificationHtml(client, q1, q2, isCoachingClient) {
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:520px;margin:24px auto;color:#1B2A4A;font-size:14px;line-height:1.7;">
  <div style="background:#1B2A4A;padding:16px 24px;border-radius:8px 8px 0 0;">
    <div style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">GPS Portal — 90-Day Closeout</div>
  </div>
  <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="font-size:15px;font-weight:700;color:#1B2A4A;margin:0 0 16px;">${esc(client.name)} has completed their 90-day sprint and requested a next sprint.</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#6B7280;width:160px;vertical-align:top;">Client</td><td style="padding:8px 0;font-weight:600;">${esc(client.name)}</td></tr>
      <tr><td style="padding:8px 0;color:#6B7280;vertical-align:top;">Email</td><td style="padding:8px 0;">${esc(client.email)}</td></tr>
      <tr><td style="padding:8px 0;color:#6B7280;vertical-align:top;">Ongoing coaching?</td><td style="padding:8px 0;">${isCoachingClient ? 'Yes' : 'No'}</td></tr>
    </table>
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #E5E7EB;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6B7280;margin-bottom:6px;">How they describe the change:</div>
      <div style="background:#F9FAFB;padding:12px 14px;border-radius:6px;font-size:14px;color:#1B2A4A;line-height:1.65;">${esc(q1 || '(no response)')}</div>
    </div>
    <div style="margin-top:16px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6B7280;margin-bottom:6px;">Next behavior focus:</div>
      <div style="background:#F9FAFB;padding:12px 14px;border-radius:6px;font-size:14px;color:#1B2A4A;line-height:1.65;">${esc(q2 || '(no response)')}</div>
    </div>
    <div style="margin-top:20px;padding:12px 14px;background:#FFF8E1;border-radius:6px;border-left:3px solid #F59E0B;font-size:13px;color:#78350F;">
      <strong>Action needed:</strong> Reach out to ${esc(client.name)} to discuss their next sprint or coaching options.
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, html, client_id, clientName, emailType) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject, html })
    });
    const data = await res.json();
    await sbFetch('/rest/v1/email_log', 'POST', {
      client_id, recipient_email: to, recipient_name: clientName,
      email_type: emailType, subject, status: res.ok ? 'sent' : 'error',
      resend_id: res.ok ? (data.id || null) : null,
      error_details: res.ok ? null : JSON.stringify(data).slice(0, 300)
    }, { 'Prefer': 'return=minimal' });
  } catch (_) {}
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
