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

  // ─── PLAN SUBMITTED (Wizard v20) ──────────────────────────────────────────
  if (body.type === 'plan_submitted') {
    // v20: new fields metric2Question, metric2Target, goal30Day, behavior1, behavior2
    // Legacy fields (goalDesc, startBehavior) also accepted for backward compat
    const {
      clientName, pillar,
      goalDesc, goalStatement, goal30Day,
      behavior1, behavior2, startBehavior,
      metricName, baseline, target,
      metric2Question, metric2Target,
      startDate, reward30, reward90,
    } = body;

    // Use new fields where available, fall back to legacy field names
    const b1       = behavior1 || startBehavior || '—';
    const b2       = behavior2 || '';
    const g90      = goalStatement || goalDesc || '—';
    const g30      = goal30Day || '';
    const isNewWiz = !!metric2Question; // true = new wizard submission

    subject = `New 90-Day Plan: ${clientName}`;

    const tdLabel = `padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;width:140px;border-bottom:1px solid #eee;`;
    const tdVal   = `padding:10px 14px;font-size:14px;color:#1a1a1a;border-bottom:1px solid #eee;`;
    const trAlt   = `background:#fafafa;`;

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
            <tr><td style="${tdLabel}">TP3 Pillar</td><td style="padding:10px 14px;font-size:14px;font-weight:700;color:#004369;border-bottom:1px solid #eee;">${pillar || '—'}</td></tr>
            <tr style="${trAlt}"><td style="${tdLabel}">90-Day Goal</td><td style="${tdVal}">${g90}</td></tr>
            ${g30 ? `<tr><td style="${tdLabel}">30-Day Goal</td><td style="${tdVal}">${g30}</td></tr>` : ''}
            <tr style="${trAlt}"><td style="${tdLabel}">Behavior 1</td><td style="${tdVal}">${b1}</td></tr>
            ${b2 ? `<tr><td style="${tdLabel}">Behavior 2</td><td style="${tdVal}">${b2}</td></tr>` : ''}
            <tr style="${trAlt}"><td style="${tdLabel}">Metric 1 (Self)</td><td style="${tdVal}">${metricName || '—'} &nbsp;<span style="font-size:12px;color:#666;">(Baseline: <strong>${baseline}</strong> → Target: <strong>${target}</strong>/week)</span></td></tr>
            ${isNewWiz ? `<tr><td style="${tdLabel}">Metric 2 (Stakeholder)</td><td style="${tdVal}">"${metric2Question}"<br/><span style="font-size:12px;color:#666;">Target avg: ${metric2Target} / 5.0</span></td></tr>` : ''}
            <tr style="${trAlt}"><td style="${tdLabel}">Plan Start</td><td style="${tdVal}">${startDate || '—'}</td></tr>
            ${reward30 ? `<tr><td style="${tdLabel}">30-Day Reward</td><td style="${tdVal}">${reward30}</td></tr>` : ''}
            ${reward90 ? `<tr style="${trAlt}"><td style="padding:10px 14px;font-size:12px;font-weight:700;text-transform:uppercase;color:#666;">90-Day Reward</td><td style="padding:10px 14px;font-size:14px;color:#1a1a1a;">${reward90}</td></tr>` : ''}
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

  // ─── WELCOME EMAIL ────────────────────────────────────────────────────────
  else if (body.type === 'welcome_email' || body.type === 'new_portal_link') {
    const { clientEmail, clientName, portalURL } = body;

    if (!clientEmail) {
      return res.status(400).json({ error: 'No client email provided.' });
    }

    const firstName = (clientName || '').split(' ')[0] || 'there';
    const isNewLink = body.type === 'new_portal_link';

    subject = isNewLink
      ? `Your updated Leadership Impact Portal link`
      : `Welcome to your Leadership Impact Portal`;

    if (isNewLink) {
      html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
          <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
            <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
            <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Updated Portal Link</div>
          </div>
          <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
            <p>Hi ${firstName},</p>
            <p>Your Leadership Impact Portal link has been updated. Use the link below going forward — your previous link is no longer active.</p>
            <div style="text-align:center;margin:28px 0;">
              <a href="${portalURL}" style="display:inline-block;background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;">Open My Leadership Portal →</a>
            </div>
            <ul style="font-size:13px;color:#444;padding-left:20px;">
              <li style="margin-bottom:8px;">Bookmark this new link or save it to your favorites so you can access it easily from your phone or computer.</li>
              <li>There is no username or password — your unique link is your access.</li>
            </ul>
            <p style="margin-top:16px;font-size:13px;color:#666;">If you have any questions, reply to this email or contact <a href="mailto:team@gpsleadership.org" style="color:#004369;">team@gpsleadership.org</a>.</p>
            <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;">
              <p style="margin:0;font-size:14px;font-weight:700;color:#004369;">Alex D. Tremble</p>
              <p style="margin:4px 0;font-size:13px;color:#555;">Founder &amp; CEO, GPS Leadership Solutions</p>
              <p style="margin:4px 0;font-size:13px;"><a href="https://www.GPSLeadership.org" style="color:#004369;text-decoration:none;">www.GPSLeadership.org</a></p>
            </div>
          </div>
        </div>`;
    } else {
      html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
          <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
            <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
            <div style="color:#ffffff;font-size:20px;font-weight:700;">Welcome to Your Leadership Impact Portal</div>
          </div>
          <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">

            <p>Hi ${firstName},</p>
            <p>Welcome to your Leadership Impact Portal.</p>
            <p>You're getting access because you're already leading at a high level, and this space is designed to help you turn that into clear goals, concrete behaviors, and visible progress over the next 90 days.</p>
            <p>The portal is meant to be quick and practical: about 10–15 minutes to set up, then 5 minutes a week to keep it moving.</p>

            <div style="margin:28px 0;padding:20px 24px;background:#f5f9f9;border-left:4px solid #01949A;border-radius:0 6px 6px 0;">
              <div style="font-weight:700;color:#004369;font-size:14px;margin-bottom:12px;">How to access your portal</div>
              <p style="margin:0 0 16px;font-size:14px;">Your personal access link is below:</p>
              <div style="text-align:center;margin:16px 0;">
                <a href="${portalURL}" style="display:inline-block;background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;">Open My Leadership Portal →</a>
              </div>
              <ul style="font-size:13px;color:#444;padding-left:20px;margin:12px 0 0;">
                <li style="margin-bottom:8px;">This link is unique to you. Please do not share or forward it.</li>
                <li style="margin-bottom:8px;">Bookmark it or add it to your favorites so you can get back in easily from your phone or computer.</li>
                <li>If you ever lose the link, email <a href="mailto:team@gpsleadership.org" style="color:#004369;">team@gpsleadership.org</a> and we'll send you a new one.</li>
              </ul>
              <p style="font-size:13px;color:#666;margin:12px 0 0;">There is no separate username or password — your unique link is your access.</p>
            </div>

            <div style="margin:24px 0;">
              <div style="font-weight:700;color:#004369;font-size:15px;margin-bottom:12px;">Getting started (first 10–15 minutes)</div>
              <p style="font-size:14px;color:#444;margin:0 0 12px;">The portal will walk you through a simple setup. Here's the path:</p>
              <table style="width:100%;border-collapse:collapse;">
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">1</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Choose your focus pillar (TP3)</div><div style="font-size:13px;color:#555;margin-top:3px;">Trust, Proactivity, or Productivity — which area do you most want to impact right now?</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">2</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Define your overall goal</div><div style="font-size:13px;color:#555;margin-top:3px;">The bigger outcome you'd like to move toward — even if it takes 6–12+ months.</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">3</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Write your 90-day goal statement</div><div style="font-size:13px;color:#555;margin-top:3px;">"What would I be proud to have accomplished in the next 90 days?" Then set a 30-day checkpoint so you know you're on track.</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">4</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Set your success metric and baseline</div><div style="font-size:13px;color:#555;margin-top:3px;">Decide how you'll measure progress. Enter your current baseline and 90-day target.</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">5</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Choose your key behavior</div><div style="font-size:13px;color:#555;margin-top:3px;">One specific action that, if done consistently, would dramatically increase your chances of hitting your goal. Be concrete: what exactly, how often, when, with whom, where.</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">6</td><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Add your stakeholders (up to three)</div><div style="font-size:13px;color:#555;margin-top:3px;">List 3 people who will be directly impacted by you reaching this goal. You can Save as Draft first if you want to give them a heads-up. If you haven't confirmed within 14 days, the system will lock in whoever you've entered.</div></td></tr>
                <tr><td style="width:28px;vertical-align:top;padding:8px 10px 8px 0;font-weight:800;font-size:15px;color:#004369;">7</td><td style="padding:8px 0;vertical-align:top;"><div style="font-weight:700;font-size:14px;">Set your rewards</div><div style="font-size:13px;color:#555;margin-top:3px;">Decide how you'll reward yourself at 30 days (for staying consistent) and at 90 days (for completing the plan). People who acknowledge progress are far more likely to keep going.</div></td></tr>
              </table>
            </div>

            <div style="margin:24px 0;padding:16px 20px;background:#f7f4ee;border-radius:8px;">
              <div style="font-weight:700;color:#004369;font-size:14px;margin-bottom:8px;">Weekly rhythm (5 minutes)</div>
              <p style="font-size:13px;color:#444;margin:0 0 8px;">Block 15 minutes once a week on your calendar — something like "Leadership Impact Review." Open your portal, mark what you did on your key behavior, note any wins or friction, and set your next action. That's it.</p>
              <p style="font-size:13px;color:#666;font-style:italic;margin:0;">Consistency beats intensity here.</p>
            </div>

            <div style="margin:24px 0;">
              <div style="font-weight:700;color:#004369;font-size:14px;margin-bottom:8px;">Get support with Ask Alex</div>
              <p style="font-size:13px;color:#444;margin:0 0 8px;">Inside the portal, you can use Ask Alex to get help between sessions — when you hit a barrier on your behavior or metric, need language for a tough conversation, or want ideas on how to remove friction around your goal. The more specific your question, the more practical the guidance you'll get back.</p>
            </div>

            <p style="font-size:14px;color:#444;margin-top:16px;">If you have any trouble with your link or aren't sure what to choose as a first goal, reply to this email or contact <a href="mailto:team@gpsleadership.org" style="color:#004369;">team@gpsleadership.org</a> and we'll help you get started.</p>
            <p>Glad to have you in here.</p>

            <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;">
              <p style="margin:0;font-size:14px;font-weight:700;color:#004369;">Alex D. Tremble</p>
              <p style="margin:4px 0;font-size:13px;color:#555;">Founder &amp; CEO, GPS Leadership Solutions</p>
              <p style="margin:4px 0;font-size:12px;color:#777;">We install simple leadership operating systems so CEOs of multi-location, operations-heavy companies stop being the bottleneck.</p>
              <p style="margin:4px 0;font-size:13px;"><a href="https://www.GPSLeadership.org" style="color:#004369;text-decoration:none;">www.GPSLeadership.org</a></p>
            </div>

            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;">
              You're receiving this because you've been enrolled in a GPS Leadership 90-Day Engagement. Questions? Reply to this email or reach out to <a href="mailto:team@gpsleadership.org" style="color:#999;">team@gpsleadership.org</a>.
            </div>
          </div>
        </div>`;
    }

    // Send to CLIENT (not Alex)
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
          to:      [clientEmail],
          subject,
          html,
        }),
      });
      const result = await response.json();
      if (!response.ok) return res.status(500).json({ error: 'Email send failed', detail: result });
      return res.status(200).json({ success: true, sent_to: clientEmail });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── WELCOME REMINDER SEQUENCE ───────────────────────────────────────────────
  // Sent to clients who haven't completed Form B (plan setup).
  // Types: welcome_reminder_1 (day 2) | welcome_reminder_2 (day 4) | welcome_reminder_3 (day 6 + archive)
  else if (body.type && body.type.startsWith('welcome_reminder_')) {
    const { clientEmail, clientName, portalURL } = body;
    if (!clientEmail) return res.status(400).json({ error: 'No client email provided.' });

    const firstName = (clientName || '').split(' ')[0] || 'there';
    const FROM      = `Alex Tremble – GPS Leadership <${RESEND_FROM}>`;

    const wrapEmail = (bodyContent) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:18px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:18px;font-weight:700;">Leadership Impact Portal</div>
        </div>
        <div style="background:#ffffff;padding:28px 28px 32px;border:1px solid #d0d0d0;border-top:none;border-radius:0 0 8px 8px;line-height:1.7;font-size:15px;">
          ${bodyContent}
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;">
            <p style="margin:0;font-size:14px;font-weight:700;color:#004369;">Alex D. Tremble</p>
            <p style="margin:4px 0;font-size:13px;color:#555;">Founder &amp; CEO, GPS Leadership Solutions</p>
            <p style="margin:4px 0;font-size:13px;"><a href="https://www.GPSLeadership.org" style="color:#004369;text-decoration:none;">www.GPSLeadership.org</a></p>
          </div>
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;">
            You're receiving this because you've been enrolled in a GPS Leadership 90-Day Engagement. Questions? Reply to this email or reach out to <a href="mailto:team@gpsleadership.org" style="color:#999;">team@gpsleadership.org</a>.
          </div>
        </div>
      </div>`;

    const portalBtn = portalURL ? `
      <div style="margin:24px 0;">
        <a href="${portalURL}" style="display:inline-block;background:#004369;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:700;">Open My Leadership Portal →</a>
      </div>` : '';

    let wrSubject, wrHtml;

    if (body.type === 'welcome_reminder_1') {
      wrSubject = `${firstName}, your portal is ready — have you had a chance to set up your plan?`;
      wrHtml = wrapEmail(`
        <p>Hi ${firstName},</p>
        <p>Just checking in — your Leadership Impact Portal is set up and ready, but I don't see your 90-day plan locked in yet.</p>
        <p>It takes about 10–15 minutes to complete. You pick your focus pillar, define your goal, set a metric, and commit to one key behavior. That's the foundation everything else builds on.</p>
        ${portalBtn}
        <p>If you ran into any trouble with the link or aren't sure where to start, reply here and I'll help you get sorted.</p>`);
    }
    else if (body.type === 'welcome_reminder_2') {
      wrSubject = `Still haven't seen your plan, ${firstName}`;
      wrHtml = wrapEmail(`
        <p>Hi ${firstName},</p>
        <p>Your portal is active, but your 90-day plan hasn't been submitted yet.</p>
        <p>Without it, the weekly check-ins, progress tracking, and Ask Alex won't have anything to work from. The plan is what makes the rest of the portal useful.</p>
        <p>It takes 10 minutes. Here's your link:</p>
        ${portalBtn}
        <p>If the timing isn't right or something's changed since we talked, just reply and let me know.</p>`);
    }
    else if (body.type === 'welcome_reminder_3') {
      wrSubject = `Last note — I'm going to close out your portal access, ${firstName}`;
      wrHtml = wrapEmail(`
        <p>Hi ${firstName},</p>
        <p>This is my last note on this. Your portal has been open for a week and your plan hasn't been set up.</p>
        <p>I'm going to close out your access for now. If you want to revisit this when the timing is better, reach out to <a href="mailto:team@gpsleadership.org" style="color:#004369;">team@gpsleadership.org</a> and we'll get you back in.</p>
        <p>If you do want to get started right now, here's your link — it's still active today:</p>
        ${portalBtn}
        <p>Either way, no hard feelings. This work lands when the timing is right.</p>`);
    }
    else {
      return res.status(400).json({ error: 'Unknown welcome reminder type' });
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [clientEmail], subject: wrSubject, html: wrHtml }),
      });
      const result = await response.json();
      if (!response.ok) return res.status(500).json({ error: 'Welcome reminder email failed', detail: result });
      return res.status(200).json({ success: true, sent_to: clientEmail, type: body.type });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── 5-DAY CONTINUATION SEQUENCE ────────────────────────────────────────────
  // Sent to the client (not coach) at key points around access expiry.
  // Types: continuation_day1am | continuation_day1pm | continuation_day2 | continuation_day3 | continuation_day5
  else if (body.type && body.type.startsWith('continuation_')) {
    const { clientEmail, clientName } = body;
    if (!clientEmail) return res.status(400).json({ error: 'No client email provided.' });

    const CALL_LINK = 'https://api.leadconnectorhq.com/widget/bookings/30-minute-coaching-discovery-call';
    const FROM      = `Alex Tremble – GPS Leadership <${RESEND_FROM}>`;
    let seqSubject, seqHtml;

    const wrapEmail = (bodyText) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7;font-size:15px;">
        <div style="background:#004369;padding:18px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;">GPS Leadership Solutions</div>
        </div>
        <div style="background:#ffffff;padding:28px 28px 32px;border:1px solid #d0d0d0;border-top:none;border-radius:0 0 8px 8px;">
          ${bodyText}
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e8e8e8;font-size:13px;color:#666;">
            <strong style="color:#1a1a1a;">Alex D. Tremble</strong><br>
            Founder &amp; CEO, GPS Leadership Solutions<br>
            <a href="https://www.GPSLeadership.org" style="color:#01949A;">www.GPSLeadership.org</a>
          </div>
        </div>
      </div>`;

    const callBtn = `
      <div style="margin:24px 0;">
        <a href="${CALL_LINK}" style="display:inline-block;background:#01949A;color:#ffffff;padding:13px 26px;border-radius:7px;font-weight:700;text-decoration:none;font-size:15px;">Schedule a Call</a>
      </div>`;

    if (body.type === 'continuation_day1am') {
      seqSubject = 'Your portal access pauses tomorrow';
      seqHtml = wrapEmail(`<p>Your access to the GPS leadership portal for this engagement wraps tomorrow. If you want to keep going together – with extended access and a structured 90‑day implementation plan – schedule a short call today:</p>${callBtn}<p>After this window, any new work goes through the standard discovery process.</p>`);
    }
    else if (body.type === 'continuation_day1pm') {
      seqSubject = 'Before your access closes tonight';
      seqHtml = wrapEmail(`<p>Last quick note before your access pauses tonight. If you've been thinking 'I should talk to Alex about this,' this is the moment.</p>${callBtn}<p>If it's not the right time, no worries – you'll still have your notes and tools to use on your own.</p>`);
    }
    else if (body.type === 'continuation_day2') {
      seqSubject = 'Holding a few spots for this cohort';
      seqHtml = wrapEmail(`<p>I've kept a small number of coaching and advisory slots this quarter specifically for leaders who went through this portal experience. Once those are spoken for, I'm back to waitlist.</p><p>If you want me in your corner while you install this with your team, here's the link to grab a time:</p>${callBtn}`);
    }
    else if (body.type === 'continuation_day3') {
      seqSubject = 'Example of how leaders use this work';
      seqHtml = wrapEmail(`<p>Most of the CEOs who get the most from this work use it to drive one concrete outcome in the next quarter (e.g., fixing delegation in their top team, or cleaning up meeting cadence).</p><p>If you want help translating what you've seen in the portal into a 90‑day execution plan for your business, book a call here:</p>${callBtn}<p>We'll map the outcomes, the behaviors, and decide if ongoing support is a fit.</p>`);
    }
    else if (body.type === 'continuation_day5') {
      seqSubject = 'Quick question about the portal';
      seqHtml = wrapEmail(`<p>Over the last few weeks you've had access to the GPS leadership portal and tools. What, if anything, has already shifted for you or your team?</p><p>If you'd like to explore a focused 90‑day plan and what ongoing support could look like, you can grab a 15–30 minute working session with me here:</p>${callBtn}<p>No pressure, just a chance to see if it makes sense.</p>`);
    }
    else {
      return res.status(400).json({ error: 'Unknown continuation type' });
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [clientEmail], subject: seqSubject, html: seqHtml }),
      });
      const result = await response.json();
      if (!response.ok) return res.status(500).json({ error: 'Continuation email failed', detail: result });
      return res.status(200).json({ success: true, sent_to: clientEmail, type: body.type });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
