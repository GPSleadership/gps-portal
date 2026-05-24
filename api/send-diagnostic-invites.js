// GPS Leadership Solutions — Send Diagnostic Survey Invites
// POST /api/send-diagnostic-invites
// Body: { diagnostic_id }
//
// What it does:
//   1. Fetches diagnostic + all raters (is_self=false) with no invited_at
//   2. Sends each rater a tokenized survey email via Resend
//   3. Updates rater.invited_at = now()
//   4. Updates diagnostic.status = 'survey_open', invites_sent_at = now()
//   5. Logs each send to email_log
//
// Called from: diagnostic-coach.html → confirmSendInvites()
//
// ENV VARS REQUIRED:
//   RESEND_API_KEY        — Resend API key
//   RESEND_FROM_EMAIL     — Sending address (default: noreply@portal.gpsleadership.org)
//   PORTAL_BASE_URL       — Base URL for portal links (default: https://portal.gpsleadership.org)
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_ANON         — Supabase anon key (RLS allows anon writes on diagnostic tables)

const SUPABASE_URL   = process.env.SUPABASE_URL   || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON  = process.env.SUPABASE_ANON  || 'sb_publishable_nu9GXGeoqDXcxVocodQ4UA_ke7Yrzyw';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM    = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE    = process.env.PORTAL_BASE_URL   || 'https://portal.gpsleadership.org';

// ── Supabase fetch helper ────────────────────────────────────────────────────
function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:          SUPABASE_ANON,
      Authorization:   `Bearer ${SUPABASE_ANON}`,
      'Content-Type':  'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Log email send to email_log ──────────────────────────────────────────────
async function logEmail({ recipientEmail, recipientName, emailType, subject, status, errorDetails, resendId }) {
  try {
    await sb('/rest/v1/email_log', 'POST',
      {
        recipient_email: recipientEmail,
        recipient_name:  recipientName || null,
        email_type:      emailType,
        subject:         subject || null,
        status,
        error_details:   errorDetails ? JSON.stringify(errorDetails) : null,
        resend_id:       resendId || null,
      },
      { Prefer: 'return=minimal' }
    );
  } catch (_) { /* logging failure must not break the main flow */ }
}

// ── Build invite email HTML ──────────────────────────────────────────────────
function buildInviteEmail({ raterName, leaderName, leaderTitle, leaderOrg, surveyLink, closeDate }) {
  const firstName   = (raterName || '').split(' ')[0] || 'there';
  const leaderFull  = [leaderName, leaderTitle, leaderOrg].filter(Boolean).join(' — ');
  const closeFmt    = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'the survey deadline';

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Leadership Feedback Request</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">

        <p>Hi ${firstName},</p>

        <p>I'm asking for your honest feedback as part of a leadership development process for:</p>

        <div style="background:#f5f7fa;border-left:4px solid #1A3D6E;padding:14px 18px;border-radius:0 6px 6px 0;margin:16px 0;">
          <strong>${leaderFull}</strong>
        </div>

        <p>This is a short survey — most people complete it in 5–8 minutes. Your responses help build a clear, honest picture of leadership strengths and development areas.</p>

        <p><strong>A few things to know:</strong></p>
        <ul style="margin:0 0 16px 0;padding-left:20px;">
          <li>Your responses are kept confidential — individual answers are never shared with the leader.</li>
          <li>Please complete it by <strong>${closeFmt}</strong>.</li>
          <li>Honest, specific feedback is the most useful. Don't overthink it.</li>
        </ul>

        <div style="margin:28px 0;text-align:center;">
          <a href="${surveyLink}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Complete the Survey →
          </a>
        </div>

        <p style="font-size:13px;color:#666;">
          Or copy this link: <a href="${surveyLink}" style="color:#1A3D6E;">${surveyLink}</a>
        </p>

        <p style="margin-top:24px;">Thank you for taking the time — this feedback genuinely matters.</p>

        <p>– Alex Tremble<br />
        <span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>

        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
          You're receiving this because you were nominated as a feedback provider for a GPS Leadership diagnostic.
          If you believe this was sent in error, please reply to this email.
        </div>
      </div>
    </div>
  `;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) {
    return res.status(400).json({ error: 'diagnostic_id is required' });
  }

  try {
    // ── 1. Fetch diagnostic ────────────────────────────────────────────────
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,close_date,status,self_assessment_completed_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) {
      return res.status(404).json({ error: 'Diagnostic not found' });
    }
    const diag = diags[0];

    // Guard: self-assessment must be complete before invites go out
    if (!diag.self_assessment_completed_at) {
      return res.status(400).json({
        error: 'Self-assessment not complete. Leader must finish the self-assessment before invites can be sent.',
      });
    }

    // ── 2. Fetch uninvited raters (is_self = false, invited_at = null) ────
    const ratersRes = await sb(
      `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&is_self=eq.false&invited_at=is.null&select=id,name,email,relationship,token`
    );
    const raters = await ratersRes.json();

    if (!Array.isArray(raters) || raters.length === 0) {
      return res.status(200).json({
        message: 'No uninvited raters found — all raters may already have been invited.',
        sent: 0,
        skipped: 0,
        errors: [],
      });
    }

    // ── 3. Send invite emails ──────────────────────────────────────────────
    let sent = 0;
    const errors = [];
    const sentList = [];
    const now = new Date().toISOString();

    for (const rater of raters) {
      const surveyLink = `${PORTAL_BASE}/diagnostic-survey.html?token=${rater.token}`;
      const subject    = `Your input is requested — ${diag.client_name} leadership feedback`;
      const html       = buildInviteEmail({
        raterName:   rater.name,
        leaderName:  diag.client_name,
        leaderTitle: diag.client_title,
        leaderOrg:   diag.client_org,
        surveyLink,
        closeDate:   diag.close_date,
      });

      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
            to:      [rater.email],
            subject,
            html,
          }),
        });
        const result = await emailRes.json();

        if (!emailRes.ok) {
          errors.push({ name: rater.name, email: rater.email, error: result });
          await logEmail({ recipientEmail: rater.email, recipientName: rater.name, emailType: 'diagnostic_invite', subject, status: 'error', errorDetails: result });
        } else {
          // Mark rater as invited
          await sb(
            `/rest/v1/diagnostic_raters?id=eq.${rater.id}`,
            'PATCH',
            { invited_at: now },
            { Prefer: 'return=minimal' }
          );
          sent++;
          sentList.push({ name: rater.name, email: rater.email });
          await logEmail({ recipientEmail: rater.email, recipientName: rater.name, emailType: 'diagnostic_invite', subject, status: 'sent', resendId: result.id });
        }
      } catch (err) {
        errors.push({ name: rater.name, email: rater.email, error: err.message });
        await logEmail({ recipientEmail: rater.email, recipientName: rater.name, emailType: 'diagnostic_invite', subject, status: 'error', errorDetails: err.message });
      }
    }

    // ── 4. Update diagnostic status if at least one invite was sent ────────
    if (sent > 0) {
      const updates = { invites_sent_at: now, updated_at: now };
      // Only advance to survey_open if not already there
      if (diag.status !== 'survey_open') {
        updates.status = 'survey_open';
      }
      await sb(
        `/rest/v1/diagnostics?id=eq.${diagnostic_id}`,
        'PATCH',
        updates,
        { Prefer: 'return=minimal' }
      );
    }

    return res.status(200).json({
      message: `Invites sent: ${sent} of ${raters.length}`,
      sent,
      sentList,
      errors: errors.length > 0 ? errors : [],
    });

  } catch (err) {
    console.error('[send-diagnostic-invites] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
