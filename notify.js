// GPS Leadership — Email Notification Function
// Deployed as a Vercel Serverless Function
// Fires when a client submits a plan (Form B) or check-in (Form A)
// Sends a formatted summary to Alex via Resend

const RESEND_API_KEY = process.env.RESEND_API_KEY;  // set in Vercel environment variables
const COACH_EMAIL    = 'alex@gpsleadership.org';
const FROM_EMAIL     = 'noreply@gpsleadership.org'; // must be verified in Resend

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || !body.type) {
    return res.status(400).json({ error: 'Missing type' });
  }

  let subject, html;

  // ─── PLAN SUBMITTED (Form B) ───────────────────────────────────────────────
  if (body.type === 'plan_submitted') {
    const { clientName, pillar, goalDesc, goalStatement, metricName, baseline, target, startDate, startBehavior, reward30, reward90 } = body;

    subject = `New 90-Day Plan: ${clientName}`;

    html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">New Plan Submitted</div>
        </div>
        <div style="background:#f5f5f5;padding:20px 28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;">

          <table style="width:100%;border-collapse:collapse;background:#ffffff;border-radius:6px;overflow:hidden;">
            <tr style="background:#004369;">
              <td colspan="2" style="padding:10px 14px;color:#ffffff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">
                ${clientName} — Plan Details
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;width:140px;border-bottom:1px solid #eee;">TP3 Pillar</td>
              <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#004369;border-bottom:1px solid #eee;">${pillar || '—'}</td>
            </tr>
            <tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">90-Day Goal</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${goalStatement || '—'}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">Goal Detail</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${goalDesc || '—'}</td>
            </tr>
            <tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">Metric</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${metricName || '—'} &nbsp;(Baseline: <strong>${baseline}</strong> → Target: <strong>${target}</strong>)</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">START Behavior</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${startBehavior || '—'}</td>
            </tr>
            <tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">Plan Start</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${startDate || '—'}</td>
            </tr>
            ${reward30 ? `<tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">30-Day Reward</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${reward30}</td>
            </tr>` : ''}
            ${reward90 ? `<tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;">90-Day Reward</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;">${reward90}</td>
            </tr>` : ''}
          </table>

          <p style="font-size:12px;color:#666;margin-top:16px;">Their 90-day engagement starts now. Week 1 check-in due in 7 days.</p>
        </div>
      </div>
    `;
  }

  // ─── CHECK-IN SUBMITTED (Form A) ───────────────────────────────────────────
  else if (body.type === 'checkin_submitted') {
    const { clientName, weekNumber, attendedCoaching, completionStatus, metricValue, plannedAction, notes } = body;

    const completionColor = completionStatus === 'Yes' ? '#2e7d32' : completionStatus === 'Partially' ? '#e65100' : '#DB1F48';
    const attendedLabel   = attendedCoaching === true ? 'Yes' : attendedCoaching === false ? 'No' : '—';

    subject = `Check-In: ${clientName} — Week ${weekNumber}`;

    html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Week ${weekNumber} Check-In — ${clientName}</div>
        </div>
        <div style="background:#f5f5f5;padding:20px 28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;">

          <table style="width:100%;border-collapse:collapse;background:#ffffff;border-radius:6px;overflow:hidden;">
            <tr style="background:#004369;">
              <td colspan="2" style="padding:10px 14px;color:#ffffff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">
                Week ${weekNumber} Summary
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;width:160px;border-bottom:1px solid #eee;">Attended Coaching</td>
              <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#004369;border-bottom:1px solid #eee;">${attendedLabel}</td>
            </tr>
            ${completionStatus ? `<tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">Follow-Through</td>
              <td style="padding:10px 14px;font-size:14px;font-weight:700;color:${completionColor};border-bottom:1px solid #eee;">${completionStatus}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">Current Metric</td>
              <td style="padding:10px 14px;font-size:22px;font-weight:800;color:#004369;border-bottom:1px solid #eee;font-family:'Arial Black',Arial,sans-serif;">${metricValue ?? '—'}</td>
            </tr>
            <tr style="background:#fafafa;">
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;border-bottom:1px solid #eee;">This Week's Action</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;">${plannedAction || '—'}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;vertical-align:top;">Reflection</td>
              <td style="padding:10px 14px;font-size:14px;color:#1a1a1a;font-style:${notes ? 'italic' : 'normal'};">${notes || '<span style="color:#999;">No notes submitted.</span>'}</td>
            </tr>
          </table>

          ${weekNumber === 9 ? `
          <div style="margin-top:16px;padding:14px 18px;background:#fff3e0;border-left:4px solid #e65100;border-radius:4px;">
            <div style="font-weight:700;color:#e65100;font-size:13px;margin-bottom:4px;">⚡ RENEWAL WINDOW</div>
            <div style="font-size:13px;color:#1a1a1a;">Week 9 — ${clientName} is in the home stretch. Start the renewal conversation on your next call.</div>
          </div>` : ''}

          <p style="font-size:12px;color:#666;margin-top:16px;">View full history in your <a href="https://YOUR_DOMAIN/coach.html" style="color:#004369;">coach dashboard</a>.</p>
        </div>
      </div>
    `;
  }

  else {
    return res.status(400).json({ error: 'Unknown notification type' });
  }

  // ─── SEND VIA RESEND ────────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `GPS Leadership <${FROM_EMAIL}>`,
        to:   [COACH_EMAIL],
        subject,
        html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(500).json({ error: 'Email send failed', detail: result });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Notification error:', err);
    return res.status(500).json({ error: err.message });
  }
}
