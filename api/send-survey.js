// api/send-survey.js
// Coach-triggered endpoint: sends a checkpoint survey to all active stakeholders for a client.
// Generates a unique token per stakeholder, stores priority_behavior + client_first_name
// in the token so the survey page can render without additional lookups.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const SITE_URL        = process.env.SITE_URL        || 'https://portal.gpsleadership.org';
const FROM_EMAIL      = 'alex@gpsleadership.org';
const FROM_NAME       = 'Alex Tremble | GPS Leadership Solutions';

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
    const { client_id, checkpoint = 'baseline', password } = req.body;

    if (!client_id)  return res.status(400).json({ error: 'client_id is required' });

    const validCheckpoints = ['baseline', 'day45', 'day90'];
    if (!validCheckpoints.includes(checkpoint)) {
      return res.status(400).json({ error: 'checkpoint must be baseline, day45, or day90' });
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authOk = await verifyPassword(password);
    if (!authOk) return res.status(401).json({ error: 'Invalid password' });

    // ── Load client ───────────────────────────────────────────────────────────
    const clientRes = await sbFetch(
      `/rest/v1/clients?id=eq.${client_id}&select=id,name,email,behavior_1,start_behavior,current_sprint_number`
    );
    if (!clientRes.ok) return res.status(500).json({ error: 'Failed to load client' });
    const clients = await clientRes.json();
    if (!clients || clients.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];

    // Resolve priority behavior — behavior_1 is the primary field; fall back to start_behavior
    // for older records that used the original field name
    const priorityBehavior = (client.behavior_1 || client.start_behavior || '').trim();
    if (!priorityBehavior) {
      return res.status(400).json({
        error: 'This client has no priority behavior on file. Have them complete their 90-day plan before sending surveys.'
      });
    }

    const clientFirstName = (client.name || '').split(' ')[0];
    const sprintNumber    = client.current_sprint_number || 1;

    // ── Load active stakeholders ──────────────────────────────────────────────
    const stakeholderRes = await sbFetch(
      `/rest/v1/stakeholders?client_id=eq.${client_id}&is_active=eq.true&select=*`
    );
    if (!stakeholderRes.ok) return res.status(500).json({ error: 'Failed to load stakeholders' });
    const stakeholders = await stakeholderRes.json();
    if (!stakeholders || stakeholders.length === 0) {
      return res.status(400).json({ error: 'No active stakeholders found for this client' });
    }

    // ── Check for existing sends at this checkpoint (current sprint only) ──────
    const existingRes = await sbFetch(
      `/rest/v1/survey_tokens?client_id=eq.${client_id}&checkpoint=eq.${checkpoint}&sprint_number=eq.${sprintNumber}&select=stakeholder_id`
    );
    const existing   = existingRes.ok ? await existingRes.json() : [];
    const alreadySentIds = new Set((existing || []).map(t => t.stakeholder_id));

    const results = { sent: [], skipped: [], errors: [] };

    for (const stakeholder of stakeholders) {
      if (alreadySentIds.has(stakeholder.id)) {
        results.skipped.push({ name: stakeholder.name, reason: 'Already sent for this checkpoint' });
        continue;
      }

      // ── Generate token ────────────────────────────────────────────────────
      const token   = generateToken();
      const now     = new Date().toISOString();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

      // ── Insert token with behavior context ────────────────────────────────
      const tokenInsert = await sbFetch('/rest/v1/survey_tokens', 'POST', {
        token,
        client_id,
        stakeholder_id:    stakeholder.id,
        checkpoint,
        priority_behavior: priorityBehavior,
        client_first_name: clientFirstName,
        sprint_number:     sprintNumber,
        sent_at:           now,
        expires_at:        expires,
        is_used:           false
      }, { 'Prefer': 'return=minimal' });

      if (!tokenInsert.ok) {
        const errText = await tokenInsert.text();
        results.errors.push({ name: stakeholder.name, error: 'Failed to create token: ' + errText.slice(0,200) });
        continue;
      }

      // ── Send email ────────────────────────────────────────────────────────
      const surveyLink = `${SITE_URL}/survey?t=${token}`;
      const emailRes   = await sendSurveyEmail(stakeholder, client, checkpoint, priorityBehavior, surveyLink);

      if (emailRes.ok) {
        const emailData = await emailRes.json();
        await logEmail({
          client_id,
          recipient_email: stakeholder.email,
          recipient_name:  stakeholder.name,
          email_type:      `survey_${checkpoint}`,
          subject:         buildSubjectLine(client.name, checkpoint),
          status:          'sent',
          resend_id:       emailData.id || null
        });
        results.sent.push({ name: stakeholder.name, email: stakeholder.email });
      } else {
        const errText = await emailRes.text();
        await logEmail({
          client_id,
          recipient_email: stakeholder.email,
          recipient_name:  stakeholder.name,
          email_type:      `survey_${checkpoint}`,
          subject:         buildSubjectLine(client.name, checkpoint),
          status:          'error',
          error_details:   errText.slice(0, 500)
        });
        results.errors.push({ name: stakeholder.name, error: 'Email delivery failed' });
      }
    }

    return res.status(200).json(results);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateToken() {
  // 32-character alphanumeric token, omitting visually ambiguous chars (0, O, I, l)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function buildSubjectLine(clientName, checkpoint) {
  const first = clientName.split(' ')[0];
  if (checkpoint === 'baseline') return `${first} would value your candid feedback`;
  if (checkpoint === 'day45')   return `Quick mid-point check-in for ${first}`;
  return `Final 90-day feedback for ${first}`;
}

function buildEmailHtml(stakeholderName, clientName, checkpoint, priorityBehavior, surveyLink) {
  const clientFirst = clientName.split(' ')[0];

  const p   = t => `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;
  const li  = t => `<li style="color:#1B2A4A;font-size:15px;line-height:1.75;margin-bottom:8px;">${t}</li>`;

  const behaviorBlock = `
    <div style="background:#F5F6F8;border-left:3px solid #C9A84C;padding:11px 16px;margin:14px 0;border-radius:0 6px 6px 0;font-size:14px;color:#1B2A4A;font-style:italic;line-height:1.65;">
      "${priorityBehavior}"
    </div>`;

  const ctaBtn = `
    <div style="text-align:center;margin:28px 0;">
      <a href="${surveyLink}" style="display:inline-block;background:#1B2A4A;color:#FFFFFF;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Complete the Survey →
      </a>
    </div>
    <p style="color:#9CA3AF;font-size:12px;line-height:1.5;margin:0 0 4px;text-align:center;">
      This link is unique to you and expires in 30 days.
    </p>`;

  const sig = `
    <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 18px;" />
    <p style="color:#4B5563;font-size:13px;line-height:1.7;margin:0;">
      Best,<br>
      <strong style="color:#1B2A4A;">Alex D. Tremble</strong><br>
      CEO &amp; Executive Advisor, GPS Leadership Solutions<br>
      On behalf of ${clientFirst}<br>
      <a href="mailto:team@gpsleadership.org" style="color:#1B2A4A;">team@gpsleadership.org</a>
    </p>`;

  let body = '';

  if (checkpoint === 'baseline') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`${clientFirst} has started a focused 90-day leadership sprint and has asked you to be one of their key stakeholders.`)}
      ${p(`You'll find a short 2-question survey below. It should take less than 3 minutes. You'll be asked to:`)}
      <ol style="margin:0 0 14px;padding-left:22px;">
        ${li(`Rate, on a 1–10 scale, how consistently ${clientFirst} has <strong>${priorityBehavior}</strong> over the last 2 weeks.`)}
        ${li(`(Optional) Share one brief example of how their current behavior around this affects you or the team.`)}
      </ol>
      ${ctaBtn}
      ${p(`This process is for development, not evaluation. Your numeric rating will be visible to both ${clientFirst} and their coach. For written comments, you can choose whether to share them with both of them or with the coach only.`)}
      ${p(`You'll notice ${clientFirst} and their coach are copied here so everyone knows this request was sent.`)}
      ${p(`Thank you in advance for your honest input — it's a key part of helping ${clientFirst} change in ways that matter.`)}`;
  }

  if (checkpoint === 'day45') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`About 45 days ago, ${clientFirst} began a 90-day leadership sprint focused on:`)}
      ${behaviorBlock}
      ${p(`You previously shared baseline feedback as one of their key stakeholders.`)}
      ${p(`We're now at the midpoint and would value a quick update from you. Please complete this very short check-in (1 question):`)}
      ${ctaBtn}
      ${p(`You'll be asked to rate, on a 1–10 scale, how consistently ${clientFirst} has demonstrated the behavior above over the last 2 weeks, plus an optional comment field.`)}
      ${p(`Your numeric rating will be visible to both ${clientFirst} and their coach. For any written comments, you can again choose whether they are shared with both or only with the coach.`)}
      ${p(`${clientFirst} and their coach are copied here so everyone knows this request was sent. Your responses are still used for development, not formal evaluation.`)}
      ${p(`Thank you again for your support and candor.`)}`;
  }

  if (checkpoint === 'day90') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`You've been part of ${clientFirst}'s 90-day leadership sprint focused on:`)}
      ${behaviorBlock}
      ${p(`We're now at the final checkpoint. To help ${clientFirst} see what has actually changed from your perspective, please complete this brief survey:`)}
      ${ctaBtn}
      ${p(`You'll be asked to:`)}
      <ol style="margin:0 0 14px;padding-left:22px;">
        ${li(`Rate, on a 1–10 scale, how consistently ${clientFirst} has demonstrated the behavior above over the last 2 weeks.`)}
        ${li(`Share, in one sentence, the most noticeable change you've experienced in the last 2–4 weeks related to this behavior, with a brief example if possible.`)}
        ${li(`(Optional) Add any additional comments, with the option to share them with both ${clientFirst} and their coach, or with the coach only.`)}
      </ol>
      ${p(`As before, your numeric rating is visible to both ${clientFirst} and their coach. Written comments follow the visibility setting you choose. The purpose remains development, not performance evaluation.`)}
      ${p(`${clientFirst} and their coach are copied so they know this request has gone out. Your honest feedback is what makes this process meaningful.`)}
      ${p(`Thank you for your time and insight.`)}`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:36px 16px;">
    <div style="background:#1B2A4A;padding:20px 28px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#C9A84C;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#FFFFFF;font-size:15px;font-weight:500;opacity:0.8;">Leadership Development Program</div>
    </div>
    <div style="background:#FFFFFF;padding:30px 36px;border-radius:0 0 8px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      ${body}
      ${sig}
    </div>
  </div>
</body>
</html>`;
}

async function sendSurveyEmail(stakeholder, client, checkpoint, priorityBehavior, surveyLink) {
  // CC the client so they see the request was sent on their behalf
  const ccAddresses = [];
  if (client.email) ccAddresses.push(client.email);

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from:    `${FROM_NAME} <${FROM_EMAIL}>`,
      to:      [stakeholder.email],
      cc:      ccAddresses,
      subject: buildSubjectLine(client.name, checkpoint),
      html:    buildEmailHtml(stakeholder.name, client.name, checkpoint, priorityBehavior, surveyLink)
    })
  });
}

async function logEmail({ client_id, recipient_email, recipient_name, email_type, subject, status, error_details, resend_id }) {
  await sbFetch('/rest/v1/email_log', 'POST', {
    client_id, recipient_email, recipient_name, email_type, subject, status,
    error_details: error_details || null,
    resend_id:     resend_id    || null
  }, { 'Prefer': 'return=minimal' });
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
