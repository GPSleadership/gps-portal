// GPS Leadership Solutions — Diagnostic Reminders & Auto-Lock Cron
// GET /api/diagnostic-reminders   (Vercel Cron — runs daily at 9am ET / 14:00 UTC)
// Can also be POST-triggered manually with { manual_trigger: true } in body
//
// What it does each run:
//   R1 — Rater reminder 1:  invited 2+ days ago, not complete, R1 not yet sent
//   R2 — Rater reminder 2:  invited 5+ days ago, not complete, R2 not yet sent
//   T-2 — Low-response alert to coach: close_date is 2 days away, < 7 completions, not yet sent
//   AUTO-LOCK — 90-day plan: debrief_completed_at was 24h+ ago, plan_status = 'active', not locked
//
// ENV VARS REQUIRED:
//   RESEND_API_KEY        — Resend API key
//   RESEND_FROM_EMAIL     — Sending address (default: noreply@portal.gpsleadership.org)
//   PORTAL_BASE_URL       — Base URL (default: https://portal.gpsleadership.org)
//   COACH_ALERT_EMAIL     — Email to receive T-2 and auto-lock alerts (default: alex@gpsleadership.org)
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_ANON         — Supabase anon key
//   CRON_SECRET           — Optional: protect manual trigger endpoint

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON     = process.env.SUPABASE_ANON     || 'sb_publishable_nu9GXGeoqDXcxVocodQ4UA_ke7Yrzyw';
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM       = process.env.RESEND_FROM_EMAIL   || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE       = process.env.PORTAL_BASE_URL     || 'https://portal.gpsleadership.org';
const COACH_EMAIL       = process.env.COACH_ALERT_EMAIL   || 'alex@gpsleadership.org';
const CRON_SECRET       = process.env.CRON_SECRET;

// ── Supabase fetch helper ────────────────────────────────────────────────────
function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_ANON,
      Authorization:  `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Log email to email_log ───────────────────────────────────────────────────
async function logEmail({ recipientEmail, emailType, subject, status, errorDetails, resendId }) {
  try {
    await sb('/rest/v1/email_log', 'POST',
      { recipient_email: recipientEmail, email_type: emailType, subject, status, error_details: errorDetails ? JSON.stringify(errorDetails) : null, resend_id: resendId || null },
      { Prefer: 'return=minimal' }
    );
  } catch (_) {}
}

// ── Send email via Resend ────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, emailType }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`, to: [to], subject, html }),
  });
  const result = await res.json();
  if (!res.ok) {
    await logEmail({ recipientEmail: to, emailType, subject, status: 'error', errorDetails: result });
    throw new Error(`Resend error: ${JSON.stringify(result)}`);
  }
  await logEmail({ recipientEmail: to, emailType, subject, status: 'sent', resendId: result.id });
  return result.id;
}

// ── Days between two dates ───────────────────────────────────────────────────
function daysBetween(earlier, later) {
  const ms = new Date(later).getTime() - new Date(earlier).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function daysFromNow(dateStr) {
  return daysBetween(new Date(), new Date(dateStr + 'T12:00:00'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

function buildReminderEmail({ raterName, leaderName, surveyLink, closeDate, isSecond }) {
  const firstName = (raterName || '').split(' ')[0] || 'there';
  const closeFmt  = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'soon';
  const urgency = isSecond
    ? `<p><strong>The survey closes ${closeFmt}.</strong> This is your last reminder.</p>`
    : `<p>The survey closes on <strong>${closeFmt}</strong> — there's still time.</p>`;

  return {
    subject: isSecond
      ? `Last reminder — ${leaderName} leadership feedback`
      : `Quick reminder — ${leaderName} leadership feedback`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">
            ${isSecond ? 'Final Reminder — ' : ''}Leadership Feedback Request
          </div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>Hi ${firstName},</p>
          <p>A quick follow-up — you haven't yet completed the feedback survey for <strong>${leaderName}</strong>.</p>
          ${urgency}
          <p>It takes 5–8 minutes. Your responses are confidential — individual answers are never shared.</p>
          <div style="margin:28px 0;text-align:center;">
            <a href="${surveyLink}" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">
              Complete the Survey →
            </a>
          </div>
          <p style="font-size:13px;color:#666;">Link: <a href="${surveyLink}" style="color:#1A3D6E;">${surveyLink}</a></p>
          <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
            If you've already completed the survey, please disregard this message.
          </div>
        </div>
      </div>
    `,
  };
}

function buildT2AlertEmail({ leaderName, closeDate, completedCount, totalInvited }) {
  const closeFmt = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'in 2 days';

  return {
    subject: `⚠️ T-2 Alert — ${leaderName} diagnostic (${completedCount}/${totalInvited} complete)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#8B1A1A;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#FFB3B3;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions — Diagnostic Alert</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Low Response Alert — ${leaderName}</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>This is an automated T-2 alert for the <strong>${leaderName}</strong> diagnostic.</p>

          <div style="background:#FFF3F3;border-left:4px solid #C0392B;padding:14px 18px;border-radius:0 6px 6px 0;margin:16px 0;">
            <strong>Survey closes: ${closeFmt}</strong><br />
            Completions: <strong>${completedCount} of ${totalInvited}</strong> raters<br />
            <strong>Minimum recommended: 7</strong>
          </div>

          <p>You may want to reach out directly to incomplete raters or extend the close date in the coach portal.</p>

          <div style="margin:28px 0;">
            <a href="${PORTAL_BASE}/diagnostic-coach.html" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;">
              Open Coach Portal →
            </a>
          </div>

          <p>– GPS Leadership Portal (automated)</p>
        </div>
      </div>
    `,
  };
}

function buildPlanLockedEmail({ leaderName, lockedAt }) {
  const lockedFmt = new Date(lockedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return {
    subject: `90-Day Plan auto-locked — ${leaderName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">90-Day Plan Auto-Locked</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>The 90-day plan for <strong>${leaderName}</strong> has been automatically locked.</p>
          <p>Lock date: <strong>${lockedFmt}</strong></p>
          <p>The plan was locked 24 hours after the debrief was marked complete. To unlock it manually, open the diagnostic in the coach portal.</p>
          <div style="margin:28px 0;">
            <a href="${PORTAL_BASE}/diagnostic-coach.html" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;">
              Open Coach Portal →
            </a>
          </div>
          <p>– GPS Leadership Portal (automated)</p>
        </div>
      </div>
    `,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: Vercel cron sets x-vercel-cron header; manual POSTs can use CRON_SECRET
  const isVercelCron    = req.headers['x-vercel-cron'] === '1';
  const isManualTrigger = req.method === 'POST' && req.body?.manual_trigger === true;
  const authHeader      = req.headers['authorization'] || '';
  const hasSecret       = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualTrigger && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = {
    r1_sent:     [],
    r2_sent:     [],
    t2_alerts:   [],
    plans_locked:[],
    errors:      [],
  };
  const now = new Date();

  try {

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 1 — RATER REMINDERS (R1 + R2)
    // Targets: diagnostics with status = 'survey_open'
    // ═══════════════════════════════════════════════════════════════════════

    const openDiagsRes = await sb(
      `/rest/v1/diagnostics?status=eq.survey_open&select=id,client_name,close_date`
    );
    const openDiags = await openDiagsRes.json() || [];

    for (const diag of openDiags) {
      // Fetch incomplete raters for this diagnostic
      const ratersRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&completed_at=is.null&invited_at=not.is.null&select=id,name,email,token,invited_at,reminder_1_sent_at,reminder_2_sent_at,email_bounced`
      );
      const raters = await ratersRes.json() || [];

      for (const rater of raters) {
        if (rater.email_bounced) continue;

        const daysSinceInvite = daysBetween(new Date(rater.invited_at), now);
        const surveyLink = `${PORTAL_BASE}/diagnostic-survey.html?token=${rater.token}`;

        // R1: 2+ days since invite, R1 not yet sent
        if (daysSinceInvite >= 2 && !rater.reminder_1_sent_at) {
          const email = buildReminderEmail({
            raterName:  rater.name,
            leaderName: diag.client_name,
            surveyLink,
            closeDate:  diag.close_date,
            isSecond:   false,
          });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_1' });
            await sb(
              `/rest/v1/diagnostic_raters?id=eq.${rater.id}`,
              'PATCH',
              { reminder_1_sent_at: now.toISOString() },
              { Prefer: 'return=minimal' }
            );
            log.r1_sent.push({ name: rater.name, diag: diag.client_name });
          } catch (err) {
            log.errors.push({ type: 'R1', name: rater.name, error: err.message });
          }
          continue; // Don't also send R2 on the same run
        }

        // R2: 5+ days since invite, R1 already sent, R2 not yet sent
        if (daysSinceInvite >= 5 && rater.reminder_1_sent_at && !rater.reminder_2_sent_at) {
          const email = buildReminderEmail({
            raterName:  rater.name,
            leaderName: diag.client_name,
            surveyLink,
            closeDate:  diag.close_date,
            isSecond:   true,
          });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_2' });
            await sb(
              `/rest/v1/diagnostic_raters?id=eq.${rater.id}`,
              'PATCH',
              { reminder_2_sent_at: now.toISOString() },
              { Prefer: 'return=minimal' }
            );
            log.r2_sent.push({ name: rater.name, diag: diag.client_name });
          } catch (err) {
            log.errors.push({ type: 'R2', name: rater.name, error: err.message });
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 2 — T-2 ALERTS
    // Fires when close_date is exactly 2 days away AND completions < 7
    // AND alert_t2_sent_at IS NULL (de-dupe guard)
    // ═══════════════════════════════════════════════════════════════════════

    const t2DiagsRes = await sb(
      `/rest/v1/diagnostics?status=eq.survey_open&alert_t2_sent_at=is.null&select=id,client_name,close_date`
    );
    const t2Diags = await t2DiagsRes.json() || [];

    for (const diag of t2Diags) {
      if (!diag.close_date) continue;
      const daysToClose = daysFromNow(diag.close_date);

      // Fire when 1.5 ≤ daysToClose ≤ 2.5 (catches the 2-day window across time zones)
      if (daysToClose < 1.5 || daysToClose > 2.5) continue;

      // Count completions (others only)
      const countRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&select=id,completed_at`
      );
      const allRaters = await countRes.json() || [];
      const completedCount = allRaters.filter(r => r.completed_at).length;
      const totalInvited   = allRaters.length;

      if (completedCount >= 7) continue; // Threshold met — no alert needed

      const email = buildT2AlertEmail({ leaderName: diag.client_name, closeDate: diag.close_date, completedCount, totalInvited });

      try {
        await sendEmail({ to: COACH_EMAIL, ...email, emailType: 'diagnostic_t2_alert' });
        await sb(
          `/rest/v1/diagnostics?id=eq.${diag.id}`,
          'PATCH',
          { alert_t2_sent_at: now.toISOString(), updated_at: now.toISOString() },
          { Prefer: 'return=minimal' }
        );
        log.t2_alerts.push({ diag: diag.client_name, completedCount, totalInvited });
      } catch (err) {
        log.errors.push({ type: 'T2_ALERT', diag: diag.client_name, error: err.message });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 3 — 90-DAY PLAN AUTO-LOCK
    // Fires 24h after debrief_completed_at if plan_status = 'active'
    // and plan_locked_at IS NULL
    // ═══════════════════════════════════════════════════════════════════════

    const debriefDiagsRes = await sb(
      `/rest/v1/diagnostics?plan_status=eq.active&plan_locked_at=is.null&debrief_completed_at=not.is.null&select=id,client_name,debrief_completed_at`
    );
    const debriefDiags = await debriefDiagsRes.json() || [];

    for (const diag of debriefDiags) {
      const hoursSinceDebrief = daysBetween(new Date(diag.debrief_completed_at), now) * 24;

      if (hoursSinceDebrief < 24) continue; // Not yet 24h

      const lockedAt = now.toISOString();
      try {
        await sb(
          `/rest/v1/diagnostics?id=eq.${diag.id}`,
          'PATCH',
          {
            plan_status:      'locked',
            plan_locked_at:   lockedAt,
            plan_lock_source: 'auto_24h',
            updated_at:       lockedAt,
          },
          { Prefer: 'return=minimal' }
        );

        // Notify coach
        const email = buildPlanLockedEmail({ leaderName: diag.client_name, lockedAt });
        await sendEmail({ to: COACH_EMAIL, ...email, emailType: 'diagnostic_plan_locked' });
        log.plans_locked.push({ diag: diag.client_name, locked_at: lockedAt });
      } catch (err) {
        log.errors.push({ type: 'AUTO_LOCK', diag: diag.client_name, error: err.message });
      }
    }

    // ── Summary response ────────────────────────────────────────────────────
    return res.status(200).json({
      ran_at:       now.toISOString(),
      r1_sent:      log.r1_sent.length,
      r2_sent:      log.r2_sent.length,
      t2_alerts:    log.t2_alerts.length,
      plans_locked: log.plans_locked.length,
      details:      log,
    });

  } catch (err) {
    console.error('[diagnostic-reminders] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
