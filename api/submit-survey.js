// api/submit-survey.js
// Handles survey form submission from survey.html.
// Validates token, prevents double submission, saves response,
// then fires notification emails to the client and Alex.

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
      token,
      client_id,
      stakeholder_id,
      checkpoint,
      score,
      open_response,
      comments,
      comments_visible_to_client
    } = req.body;

    if (!token || !client_id || !stakeholder_id || !checkpoint || score == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (score < 1 || score > 10 || !Number.isInteger(score)) {
      return res.status(400).json({ error: 'Score must be an integer between 1 and 10' });
    }

    // ── Validate token ────────────────────────────────────────────────────────
    const tokenRes = await sbFetch(
      `/rest/v1/survey_tokens?token=eq.${encodeURIComponent(token)}&client_id=eq.${client_id}&select=*`
    );
    if (!tokenRes.ok) return res.status(500).json({ error: 'Token lookup failed' });
    const tokens = await tokenRes.json();
    if (!tokens || tokens.length === 0) return res.status(404).json({ error: 'Invalid survey link' });

    const tokenRecord = tokens[0];
    if (tokenRecord.is_used) return res.status(409).json({ error: 'This survey has already been submitted' });
    if (tokenRecord.expires_at && new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This survey link has expired' });
    }

    // ── Save response ─────────────────────────────────────────────────────────
    const insertRes = await sbFetch('/rest/v1/survey_responses', 'POST', {
      client_id,
      stakeholder_id,
      token_id:                   tokenRecord.id,
      checkpoint,
      score,
      open_response:              open_response || null,
      comments:                   comments      || null,
      comments_visible_to_client: comments_visible_to_client !== false
    }, { 'Prefer': 'return=minimal' });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(500).json({ error: 'Failed to save response', detail: errText });
    }

    // ── Mark token used ───────────────────────────────────────────────────────
    await sbFetch(
      `/rest/v1/survey_tokens?id=eq.${tokenRecord.id}`,
      'PATCH',
      { is_used: true, used_at: new Date().toISOString() },
      { 'Prefer': 'return=minimal' }
    );

    // ── Fire notifications (non-blocking — don't let these delay the response) ─
    sendResponseNotifications({
      client_id,
      stakeholder_id,
      checkpoint,
      score,
      comments_visible_to_client: comments_visible_to_client !== false,
      tokenRecord
    }).catch(() => {}); // fire-and-forget

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Notification logic ────────────────────────────────────────────────────────

async function sendResponseNotifications({ client_id, stakeholder_id, checkpoint, score, comments_visible_to_client, tokenRecord }) {
  // Fetch client + stakeholder in parallel
  const [clientRes, stakeholderRes] = await Promise.all([
    sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=name,email`),
    sbFetch(`/rest/v1/stakeholders?id=eq.${stakeholder_id}&select=name,role`)
  ]);

  const clients      = clientRes.ok      ? await clientRes.json()      : [];
  const stakeholders = stakeholderRes.ok ? await stakeholderRes.json() : [];

  const client      = clients[0];
  const stakeholder = stakeholders[0];

  if (!client || !stakeholder) return;

  const clientFirst       = (client.name || '').split(' ')[0];
  const stakeholderName   = stakeholder.name || 'A stakeholder';
  const checkpointLabel   = checkpoint === 'baseline' ? 'Baseline'
                          : checkpoint === 'day45'    ? 'Day 45'
                          : 'Day 90';

  // ── Notify the client ─────────────────────────────────────────────────────
  if (client.email) {
    const clientSubject = `${stakeholderName} just completed your ${checkpointLabel} survey`;
    const clientHtml    = buildClientNotificationHtml(clientFirst, stakeholderName, checkpointLabel, score);
    await sendEmail(client.email, clientSubject, clientHtml, client_id, client.name, 'survey_response_client');
  }

  // ── Notify Alex ───────────────────────────────────────────────────────────
  const alexSubject = `[GPS] ${clientFirst}'s ${checkpointLabel} feedback — ${stakeholderName} | ${score}/10`;
  const alexHtml    = buildAlexNotificationHtml(client.name, stakeholderName, checkpointLabel, score, stakeholder.role || '');
  await sendEmail(ALEX_EMAIL, alexSubject, alexHtml, client_id, client.name, 'survey_response_alex');
}

function buildClientNotificationHtml(clientFirst, stakeholderName, checkpointLabel, score) {
  const p = t => `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:36px 16px;">
    <div style="background:#1B2A4A;padding:20px 28px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#C9A84C;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#FFFFFF;font-size:15px;font-weight:500;opacity:0.8;">Feedback Received</div>
    </div>
    <div style="background:#FFFFFF;padding:30px 36px;border-radius:0 0 8px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      ${p(`Hi ${clientFirst},`)}
      ${p(`<strong>${stakeholderName}</strong> just completed your ${checkpointLabel} survey.`)}
      <div style="background:#F5F6F8;border-left:3px solid #C9A84C;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0;">
        <div style="font-size:13px;color:#6B7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Score</div>
        <div style="font-size:28px;font-weight:700;color:#1B2A4A;">${score}<span style="font-size:16px;color:#9CA3AF;">/10</span></div>
      </div>
      ${p(`Log in to your portal to see the full picture once all responses are in.`)}
      <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 18px;" />
      <p style="color:#4B5563;font-size:13px;line-height:1.7;margin:0;">
        — Alex Tremble<br>
        GPS Leadership Solutions
      </p>
    </div>
  </div>
</body>
</html>`;
}

function buildAlexNotificationHtml(clientName, stakeholderName, checkpointLabel, score, stakeholderRole) {
  const scoreColor = score >= 8 ? '#16a34a' : score >= 5 ? '#d97706' : '#dc2626';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:520px;margin:24px auto;color:#1B2A4A;font-size:14px;line-height:1.7;">
  <div style="background:#1B2A4A;padding:16px 24px;border-radius:8px 8px 0 0;">
    <div style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">GPS Portal — Survey Response</div>
  </div>
  <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6B7280;width:140px;">Client</td><td style="padding:6px 0;font-weight:600;">${clientName}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Stakeholder</td><td style="padding:6px 0;">${stakeholderName}${stakeholderRole ? ` <span style="color:#9CA3AF;font-size:12px;">(${stakeholderRole})</span>` : ''}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Checkpoint</td><td style="padding:6px 0;">${checkpointLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Score</td><td style="padding:6px 0;font-size:20px;font-weight:700;color:${scoreColor};">${score}<span style="font-size:13px;color:#9CA3AF;">/10</span></td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Submitted</td><td style="padding:6px 0;">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} ET</td></tr>
    </table>
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, html, client_id, clientName, emailType) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    `${FROM_NAME} <${FROM_EMAIL}>`,
        to:      [to],
        subject,
        html
      })
    });

    const data = await res.json();
    await logEmail({
      client_id,
      recipient_email: to,
      recipient_name:  clientName,
      email_type:      emailType,
      subject,
      status:          res.ok ? 'sent' : 'error',
      resend_id:       res.ok ? (data.id || null) : null,
      error_details:   res.ok ? null : JSON.stringify(data).slice(0, 500)
    });
  } catch (_) {
    // Notification failure is non-fatal
  }
}

async function logEmail({ client_id, recipient_email, recipient_name, email_type, subject, status, error_details, resend_id }) {
  try {
    await sbFetch('/rest/v1/email_log', 'POST', {
      client_id, recipient_email, recipient_name, email_type, subject, status,
      error_details: error_details || null,
      resend_id:     resend_id    || null
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
