// api/survey-reminders.js
// Vercel Cron Job: runs daily at 14:00 UTC.
// Sends stakeholder survey reminders at 2-day intervals after the initial survey send.
//
// Reminder schedule (days after original send or last reminder):
//   Reminder 1 — sent_at + 2 days
//   Reminder 2 — reminder_1_sent_at + 2 days
//   Reminder 3 — reminder_2_sent_at + 2 days  (labeled "Final")
//   Flag non-response — reminder_3_sent_at + 2 days (no email, sets non_response_flagged = true)
//
// Only processes tokens where is_used = false and email_bounced = false.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const SITE_URL        = process.env.SITE_URL        || 'https://portal.gpsleadership.org';
const FROM_EMAIL      = 'alex@gpsleadership.org';
const FROM_NAME       = 'Alex Tremble | GPS Leadership Solutions';
const CRON_SECRET     = process.env.CRON_SECRET;

const REMINDER_INTERVAL_DAYS = 2;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Auth: Vercel cron header, CRON_SECRET, or manual_trigger flag (from coach portal)
  const authHeader   = req.headers['authorization'] || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret    = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = req.method === 'POST' && req.body?.manual_trigger === true;

  if (!isVercelCron && !hasSecret && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();

    // ── Auto-confirm draft stakeholders older than 14 days ────────────────────
    // Stakeholders added by clients start with confirmed_at = NULL (draft).
    // If they haven't been manually confirmed within 14 days, confirm them now.
    const cutoff14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const autoConfirmRes = await sbFetch(
      `/rest/v1/stakeholders?confirmed_at=is.null&is_active=eq.true&created_at=lt.${encodeURIComponent(cutoff14)}`,
      'PATCH',
      { confirmed_at: now.toISOString() },
      { 'Prefer': 'return=minimal' }
    );
    // Non-blocking — don't fail the whole run if this errors

    // ── Auto-archive clients inactive for 45+ days ────────────────────────────
    // "Activity" = any portal action tracked via last_active_at in client.html.
    // Falls back to created_at for clients who have never used the portal.
    // Two passes: (1) clients with a recorded last_active_at that is stale,
    //             (2) clients who have never been active and are old enough.
    const cutoff45 = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    await sbFetch(
      `/rest/v1/clients?is_archived=eq.false&last_active_at=lt.${encodeURIComponent(cutoff45)}`,
      'PATCH',
      { is_archived: true },
      { 'Prefer': 'return=minimal' }
    );
    await sbFetch(
      `/rest/v1/clients?is_archived=eq.false&last_active_at=is.null&created_at=lt.${encodeURIComponent(cutoff45)}`,
      'PATCH',
      { is_archived: true },
      { 'Prefer': 'return=minimal' }
    );
    // Non-blocking — don't fail the whole run if these error

    // ── Load all pending tokens with embedded stakeholder info ─────────────────
    const tokensRes = await sbFetch(
      `/rest/v1/survey_tokens?is_used=eq.false&email_bounced=eq.false` +
      `&select=id,token,client_id,checkpoint,client_first_name,sent_at,` +
      `reminder_1_sent_at,reminder_2_sent_at,reminder_3_sent_at,non_response_flagged,` +
      `stakeholders(id,name,email)`
    );

    if (!tokensRes.ok) {
      return res.status(500).json({ error: 'Failed to load survey tokens' });
    }

    const tokens = await tokensRes.json();

    if (!tokens || tokens.length === 0) {
      return res.status(200).json({
        message: 'No pending survey tokens found.',
        results: { sent: [], flagged: [], skipped: [], errors: [] }
      });
    }

    const results = { sent: [], flagged: [], skipped: [], errors: [] };

    for (const tk of tokens) {
      const stakeholder = tk.stakeholders;
      if (!stakeholder || !stakeholder.email) {
        results.skipped.push({ token_id: tk.id, reason: 'No stakeholder email on file' });
        continue;
      }

      // ── Determine what action to take ──────────────────────────────────────
      const sinceSent      = diffDays(tk.sent_at, now);
      const sinceReminder1 = diffDays(tk.reminder_1_sent_at, now);
      const sinceReminder2 = diffDays(tk.reminder_2_sent_at, now);
      const sinceReminder3 = diffDays(tk.reminder_3_sent_at, now);

      let action = null;

      if (!tk.reminder_1_sent_at && sinceSent >= REMINDER_INTERVAL_DAYS) {
        action = 'reminder_1';
      } else if (tk.reminder_1_sent_at && !tk.reminder_2_sent_at && sinceReminder1 >= REMINDER_INTERVAL_DAYS) {
        action = 'reminder_2';
      } else if (tk.reminder_2_sent_at && !tk.reminder_3_sent_at && sinceReminder2 >= REMINDER_INTERVAL_DAYS) {
        action = 'reminder_3';
      } else if (tk.reminder_3_sent_at && !tk.non_response_flagged && sinceReminder3 >= REMINDER_INTERVAL_DAYS) {
        action = 'flag_nonresponse';
      }

      if (!action) {
        results.skipped.push({ name: stakeholder.name, checkpoint: tk.checkpoint, reason: 'Not yet due' });
        continue;
      }

      // ── Flag non-response (no email) ────────────────────────────────────────
      if (action === 'flag_nonresponse') {
        const flagRes = await sbFetch(
          `/rest/v1/survey_tokens?id=eq.${tk.id}`,
          'PATCH',
          { non_response_flagged: true },
          { 'Prefer': 'return=minimal' }
        );
        if (flagRes.ok) {
          results.flagged.push({ name: stakeholder.name, checkpoint: tk.checkpoint });
        } else {
          results.errors.push({ name: stakeholder.name, error: 'Failed to set non_response_flagged' });
        }
        continue;
      }

      // ── Send reminder email ─────────────────────────────────────────────────
      const reminderNum  = action === 'reminder_1' ? 1 : action === 'reminder_2' ? 2 : 3;
      const surveyLink   = `${SITE_URL}/survey?t=${tk.token}`;
      const templateKey  = `survey_reminder_${reminderNum}`;
      const tpl          = await getApprovedTemplate(templateKey);
      const subject      = tpl
        ? fillPlaceholders(tpl.subject,    tk.client_first_name, stakeholder.name, surveyLink)
        : buildSubject(tk.client_first_name, reminderNum);
      const html         = tpl
        ? buildHtmlFromTemplate(fillPlaceholders(tpl.body_text, tk.client_first_name, stakeholder.name, surveyLink))
        : buildReminderHtml(stakeholder.name, tk.client_first_name, surveyLink, reminderNum);

      const emailRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from:    `${FROM_NAME} <${FROM_EMAIL}>`,
          to:      [stakeholder.email],
          subject,
          html
        })
      });

      const patchField = `reminder_${reminderNum}_sent_at`;
      const sentAt     = now.toISOString();

      if (emailRes.ok) {
        const emailData = await emailRes.json();
        // Mark reminder sent on token
        await sbFetch(
          `/rest/v1/survey_tokens?id=eq.${tk.id}`,
          'PATCH',
          { [patchField]: sentAt },
          { 'Prefer': 'return=minimal' }
        );
        // Log to email_log
        await logEmail({
          client_id:       tk.client_id,
          recipient_email: stakeholder.email,
          recipient_name:  stakeholder.name,
          email_type:      `survey_${action}`,
          subject,
          status:          'sent',
          resend_id:       emailData.id || null
        });
        results.sent.push({
          name:       stakeholder.name,
          email:      stakeholder.email,
          reminder:   reminderNum,
          checkpoint: tk.checkpoint
        });
      } else {
        const errText = await emailRes.text();
        await logEmail({
          client_id:       tk.client_id,
          recipient_email: stakeholder.email,
          recipient_name:  stakeholder.name,
          email_type:      `survey_${action}`,
          subject,
          status:          'error',
          error_details:   errText.slice(0, 500)
        });
        results.errors.push({
          name:  stakeholder.name,
          error: 'Email delivery failed'
        });
      }
    }

    // ── 5-Day continuation sequence for non-coaching clients ─────────────────
    // Fires emails keyed to days before/after portal access expires.
    // Sequence: Day1AM (day before expiry) → Day1PM (expiry day) →
    //           Day2 (1 day after) → Day3 (2 days after) → Day5 (4 days after).
    // Tracked via continuation_step on the clients row (0 = not started, 5 = complete).
    const seqClientsRes = await sbFetch(
      `/rest/v1/clients?is_coaching_client=eq.false&is_archived=eq.false` +
      `&portal_first_active_at=not.is.null&continuation_step=lt.5` +
      // phone, sms_opt_in, timezone fetched here for the SMS_HOOK above
      `&select=id,email,name,portal_first_active_at,continuation_step,phone,sms_opt_in,timezone`
    );

    if (seqClientsRes.ok) {
      const seqClients = await seqClientsRes.json() || [];
      const NOTIFY_URL = `${SITE_URL}/api/notify`;

      for (const c of seqClients) {
        if (!c.email || !c.portal_first_active_at) continue;

        const firstActive = new Date(c.portal_first_active_at);
        firstActive.setHours(0, 0, 0, 0);
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const expiryDate = new Date(firstActive);
        expiryDate.setDate(expiryDate.getDate() + 90);
        const daysLeft = Math.round((expiryDate - today) / (24 * 60 * 60 * 1000));
        const step = c.continuation_step || 0;

        // Determine which email to send based on step and days remaining
        let emailType = null;
        if (step === 0 && daysLeft === 1)  emailType = 'continuation_day1am';
        if (step === 1 && daysLeft === 0)  emailType = 'continuation_day1pm';
        if (step === 2 && daysLeft === -1) emailType = 'continuation_day2';
        if (step === 3 && daysLeft === -2) emailType = 'continuation_day3';
        if (step === 4 && daysLeft === -4) emailType = 'continuation_day5';

        // SMS_HOOK — 5 days before portal access ends (daysLeft === 5):
        // If c.sms_opt_in is true and c.phone is present, send a one-time SMS reminder
        // alerting the client that their portal access expires in 5 days.
        // No marketing — access reminder only. Respect c.timezone for send time.
        // Wire this when Twilio (or equivalent SMS provider) is configured.
        // Required fields on client row: phone (E.164), sms_opt_in (boolean), timezone (IANA).
        // Example: if (daysLeft === 5 && c.sms_opt_in && c.phone) { await sendSms(c.phone, msg); }

        if (!emailType) continue;

        try {
          const notifyRes = await fetch(NOTIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: emailType,
              clientEmail: c.email,
              clientName:  c.name || '',
            }),
          });

          if (notifyRes.ok) {
            // Advance the step so the same email never fires twice
            await sbFetch(
              `/rest/v1/clients?id=eq.${c.id}`,
              'PATCH',
              { continuation_step: step + 1 },
              { 'Prefer': 'return=minimal' }
            );
            results.sent.push({ client_id: c.id, type: emailType });
          } else {
            results.errors.push({ client_id: c.id, type: emailType, error: 'Notify call failed' });
          }
        } catch (seqErr) {
          results.errors.push({ client_id: c.id, type: emailType, error: seqErr.message });
        }
      }
    }
    // Non-blocking — don't fail the whole cron if this section errors

    // ── Welcome reminder sequence for clients who haven't completed Form B ────
    // Fires at day 2, 4, and 6 after welcome_sent_at if plan_submitted_at is null.
    // After the 3rd reminder, client is auto-archived.
    // Tracked via welcome_reminder_step (0=none, 1=day2, 2=day4, 3=day6+archived).
    const wrClientsRes = await sbFetch(
      `/rest/v1/clients?is_archived=eq.false&welcome_sent_at=not.is.null` +
      `&plan_submitted_at=is.null&welcome_reminder_step=lt.3` +
      `&select=id,email,name,token,welcome_sent_at,welcome_reminder_step`
    );

    if (wrClientsRes.ok) {
      const wrClients = await wrClientsRes.json() || [];
      const NOTIFY_URL = `${SITE_URL}/api/notify`;

      for (const c of wrClients) {
        if (!c.email || !c.welcome_sent_at) continue;

        const welcomeSent = new Date(c.welcome_sent_at);
        welcomeSent.setHours(0, 0, 0, 0);
        const todayMid = new Date(now);
        todayMid.setHours(0, 0, 0, 0);
        const daysSince = Math.floor((todayMid - welcomeSent) / (24 * 60 * 60 * 1000));
        const step = c.welcome_reminder_step || 0;

        // Determine which reminder to send
        let wrType = null;
        if (step === 0 && daysSince >= 2) wrType = 'welcome_reminder_1';
        if (step === 1 && daysSince >= 4) wrType = 'welcome_reminder_2';
        if (step === 2 && daysSince >= 6) wrType = 'welcome_reminder_3';

        if (!wrType) continue;

        const portalURL = `${SITE_URL}/client.html?token=${c.token}`;

        try {
          const notifyRes = await fetch(NOTIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type:        wrType,
              clientEmail: c.email,
              clientName:  c.name || '',
              portalURL
            }),
          });

          if (notifyRes.ok) {
            const newStep = step + 1;
            const patch = { welcome_reminder_step: newStep };
            // Auto-archive after the 3rd and final reminder
            if (newStep === 3) patch.is_archived = true;

            await sbFetch(
              `/rest/v1/clients?id=eq.${c.id}`,
              'PATCH',
              patch,
              { 'Prefer': 'return=minimal' }
            );
            results.sent.push({ client_id: c.id, type: wrType });
          } else {
            results.errors.push({ client_id: c.id, type: wrType, error: 'Notify call failed' });
          }
        } catch (wrErr) {
          results.errors.push({ client_id: c.id, type: wrType, error: wrErr.message });
        }
      }
    }
    // Non-blocking — don't fail the whole cron if this section errors

    return res.status(200).json({
      message: `Done. Sent: ${results.sent.length} | Flagged: ${results.flagged.length} | Errors: ${results.errors.length}`,
      results
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Days elapsed since a timestamp. Returns 0 if timestamp is null/undefined.
 */
function diffDays(timestamp, now) {
  if (!timestamp) return 0;
  return Math.floor((now - new Date(timestamp)) / (1000 * 60 * 60 * 24));
}

function buildSubject(clientFirstName, reminderNum) {
  if (reminderNum === 1) return `Quick reminder: ${clientFirstName} is waiting on your feedback`;
  if (reminderNum === 2) return `Still waiting on your feedback for ${clientFirstName}`;
  return `Final reminder: feedback for ${clientFirstName}`;
}

function buildReminderHtml(stakeholderName, clientFirstName, surveyLink, reminderNum) {
  const p   = t => `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;

  const ctaBtn = `
    <div style="text-align:center;margin:28px 0;">
      <a href="${surveyLink}"
         style="display:inline-block;background:#1B2A4A;color:#FFFFFF;text-decoration:none;
                padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Complete the Survey →
      </a>
    </div>
    <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0 0 4px;">
      This link is unique to you.
    </p>`;

  const sig = `
    <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 18px;" />
    <p style="color:#4B5563;font-size:13px;line-height:1.7;margin:0;">
      Best,<br>
      <strong style="color:#1B2A4A;">Alex D. Tremble</strong><br>
      CEO &amp; Executive Advisor, GPS Leadership Solutions<br>
      On behalf of ${clientFirstName}<br>
      <a href="mailto:team@gpsleadership.org" style="color:#1B2A4A;">team@gpsleadership.org</a>
    </p>`;

  let body = '';

  if (reminderNum === 1) {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`Just a quick reminder — ${clientFirstName} is waiting on your feedback as part of their 90-day leadership development program.`)}
      ${ctaBtn}
      ${p(`It takes under 3 minutes. Your honest input matters.`)}`;
  } else if (reminderNum === 2) {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`We're still missing your feedback for ${clientFirstName}'s leadership development program. This is the second reminder.`)}
      ${ctaBtn}
      ${p(`The survey takes under 3 minutes and directly shapes the coaching work ${clientFirstName} is doing. Your perspective matters.`)}`;
  } else {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`This is the final reminder for ${clientFirstName}'s leadership survey. If you're not able to complete it, no action is needed — we'll note your non-response in the program record.`)}
      ${ctaBtn}
      ${p(`If you are able to take 3 minutes, your feedback is still valuable. Thank you either way.`)}`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
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

/**
 * Fetch an approved template by key. Returns null if not found or not approved.
 * Cached per-request to avoid repeated DB calls.
 */
const _tplCache = {};
async function getApprovedTemplate(templateKey) {
  if (_tplCache[templateKey] !== undefined) return _tplCache[templateKey];
  const res = await sbFetch(
    `/rest/v1/email_templates?template_key=eq.${encodeURIComponent(templateKey)}&is_approved=eq.true&select=subject,body_text&limit=1`
  );
  if (!res.ok) { _tplCache[templateKey] = null; return null; }
  const data = await res.json();
  _tplCache[templateKey] = (data && data[0]) ? data[0] : null;
  return _tplCache[templateKey];
}

/**
 * Replace placeholders in a template string.
 * Supported: [ClientFirstName] [StakeholderFirstName] [SurveyLink]
 */
function fillPlaceholders(text, clientFirstName, stakeholderName, surveyLink) {
  return (text || '')
    .replace(/\[ClientFirstName\]/g,      clientFirstName  || '')
    .replace(/\[StakeholderFirstName\]/g, (stakeholderName || '').split(' ')[0] || '')
    .replace(/\[SurveyLink\]/g,           surveyLink       || '');
}

/**
 * Wrap plain-text template body in branded HTML email shell.
 */
function buildHtmlFromTemplate(plainText) {
  const lines = (plainText || '').split('\n');
  const body  = lines.map(line => {
    const t = line.trim();
    if (!t) return '';
    return `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;
  }).join('');

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
    </div>
  </div>
</body>
</html>`;
}

async function logEmail({ client_id, recipient_email, recipient_name, email_type, subject, status, error_details, resend_id }) {
  try {
    await sbFetch('/rest/v1/email_log', 'POST', {
      client_id, recipient_email, recipient_name, email_type, subject, status,
      error_details: error_details || null,
      resend_id:     resend_id    || null
    }, { 'Prefer': 'return=minimal' });
  } catch (_) {
    // Logging failure should never break the main send flow
  }
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
