// GPS Leadership — Email Notification Function
// Deployed as a Vercel Serverless Function
// Fires when a client submits a plan (Form B) or check-in (Form A)
// Sends a formatted summary to Alex via Resend

const RESEND_API_KEY = process.env.RESEND_API_KEY;                                          // Vercel env var: RESEND_API_KEY
const RESEND_FROM    = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org'; // Vercel env var: RESEND_FROM_EMAIL
const COACH_EMAIL    = 'alex@gpsleadership.org';

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

          <p style="font-size:12px;color:#666;margin-top:16px;">View full history in your <a href="https://portal.gpsleadership.org/coach.html" style="color:#004369;">coach dashboard</a>.</p>
        </div>
      </div>
    `;
  }

  // ─── PASSWORD CHANGE VERIFICATION ─────────────────────────────────────────
  else if (body.type === 'password_change_request') {
    const { code } = body;

    subject = `GPS Portal — Your verification code: ${code}`;

    html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Coach Dashboard — Password Change</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>A password change was requested for your GPS Coach Dashboard.</p>
          <p style="margin-top:20px;">Your verification code is:</p>
          <div style="margin:24px 0;text-align:center;">
            <span style="font-family:'Arial Black',Arial,sans-serif;font-size:42px;font-weight:900;letter-spacing:10px;color:#004369;">${code}</span>
          </div>
          <p style="font-size:13px;color:#666;">This code expires in 15 minutes. If you did not request a password change, ignore this email.</p>
        </div>
      </div>
    `;

    // Send to Alex (coach only)
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    `GPS Leadership <${RESEND_FROM}>`,
          to:      [COACH_EMAIL],
          subject,
          html,
        }),
      });
      const result = await response.json();
      if (!response.ok) return res.status(500).json({ error: 'Verification email failed', detail: result });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── WEEK 9 CLIENT EMAIL ───────────────────────────────────────────────────
  else if (body.type === 'week9_client') {
    const { clientEmail, clientName, metricName, baseline, currentValue, target, goalStatement, startBehavior } = body;

    if (!clientEmail) {
      return res.status(400).json({ error: 'No client email on file — week 9 email not sent.' });
    }

    const firstName = (clientName || '').split(' ')[0] || 'there';

    subject = `Week 9 – You're in the home stretch, ${firstName}`;

    html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Week 9 — You're in the home stretch</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">

          <p>Hi ${firstName},</p>

          <p>You're about nine weeks into this 90-day sprint.</p>

          <p>When you started, <strong>${metricName || 'your metric'}</strong> was at <strong>${baseline ?? '—'}</strong>. Today it's at <strong>${currentValue ?? '—'}</strong>, working toward <strong>${target ?? '—'}</strong> and your goal of <em>"${goalStatement || '—'}"</em></p>

          <p>That shift didn't happen by accident. It came from you actually doing <strong>${startBehavior || 'the work'}</strong> instead of just talking about it.</p>

          <p>The next three weeks matter more than most people think. This is where a lot of leaders ease up. Don't. The habits you run now are the ones that will stick 90 days from today.</p>

          <p>It's also the right time to look past this finish line:</p>

          <ul style="padding-left:20px;margin:16px 0;">
            <li style="margin-bottom:10px;">What do you want your leadership to look like in the next 90 days?</li>
            <li style="margin-bottom:10px;">Where do you still feel pressure, friction, or risk?</li>
            <li style="margin-bottom:10px;">What support would make it easier to keep this going instead of sliding back?</li>
          </ul>

          <p>On our next call, I'll bring a recommendation for your next 90-day focus and what ongoing coaching could look like if you want to keep working together. Come ready with your answers to the three questions above.</p>

          <p style="margin-top:32px;">– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>

          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
            You're receiving this because you're enrolled in a GPS Leadership 90-Day Engagement.
          </div>
        </div>
      </div>
    `;

    // Send to CLIENT (not Alex)
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
          to:      [clientEmail],
          subject,
          html,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        console.error('Week 9 email error:', result);
        return res.status(500).json({ error: 'Week 9 email failed', detail: result });
      }

      return res.status(200).json({ success: true, sent_to: clientEmail });
    } catch (err) {
      console.error('Week 9 email exception:', err);
      return res.status(500).json({ error: err.message });
    }
  }


  // ─── TEST REMINDER (preview for Alex) ────────────────────────────────────
  else if (body.type === 'test_reminder') {
    const sampleWeek    = 3;
    const sampleFirst   = 'David';
    const sampleLink    = 'https://portal.gpsleadership.org/client.html?token=SAMPLE';

    const gcalTitle   = encodeURIComponent('GPS Leadership — Weekly Check-In');
    const gcalDetails = encodeURIComponent(`Complete your weekly GPS Leadership check-in at ${sampleLink}`);
    const now = new Date();
    const gcalDate = (() => {
      const d = new Date(now);
      const day = d.getUTCDay();
      const daysUntil = day === 1 ? 0 : (8 - day) % 7;
      d.setUTCDate(d.getUTCDate() + daysUntil);
      d.setUTCHours(14, 0, 0, 0);
      const end = new Date(d.getTime() + 15 * 60 * 1000);
      const fmt = (dt) => dt.toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
      return `${fmt(d)}%2F${fmt(end)}`;
    })();
    const gcalLink = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${gcalTitle}&details=${gcalDetails}&recur=RRULE%3AFREQ%3DWEEKLY%3BBYDAY%3DMO&dates=${gcalDate}`;
    const icsLink  = `https://portal.gpsleadership.org/api/reminder-calendar`;

    subject = `[TEST PREVIEW] Week ${sampleWeek} check-in — a quick reminder, ${sampleFirst}`;

    html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#6b6b6b;padding:10px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">⚙️ TEST PREVIEW — This is what your clients receive each Monday</div>
        </div>
        <div style="background:#004369;padding:20px 28px;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Week ${sampleWeek} Check-In Reminder</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">

          <p>Hi ${sampleFirst},</p>

          <p>Just a quick heads-up — your Week ${sampleWeek} check-in is ready for you.</p>

          <p>It takes less than two minutes. Log your metric, note what you did this week, and set your action for next week. That's it.</p>

          <p>The leaders who move fastest are the ones who stay honest with themselves weekly — not just on coaching calls.</p>

          <div style="margin:28px 0;text-align:center;">
            <a href="${sampleLink}"
               style="background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
              Complete My Week ${sampleWeek} Check-In →
            </a>
          </div>

          <div style="margin-top:4px;padding:16px 20px;background:#f7f4ee;border-radius:8px;text-align:center;">
            <p style="font-size:12px;color:#666;margin:0 0 8px 0;">Want a recurring Monday reminder on your calendar?</p>
            <a href="${gcalLink}" style="color:#004369;font-size:13px;font-weight:700;text-decoration:none;margin-right:20px;">📅 Add to Google Calendar</a>
            <a href="${icsLink}" style="color:#004369;font-size:13px;font-weight:700;text-decoration:none;">🗓 Add to Apple / Outlook</a>
          </div>

          <p style="margin-top:32px;">– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>

          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
            You're receiving this because you're enrolled in a GPS Leadership 90-Day Engagement.<br/>
            Questions? Reply to this email or reach out to alex@gpsleadership.org.
          </div>
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
        from: `GPS Leadership <${RESEND_FROM}>`,
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
