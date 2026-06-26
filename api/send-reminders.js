import crypto from 'node:crypto';
// GPS Leadership — Weekly Check-In Reminder
// Vercel Cron Job: runs every Monday at 9am ET (14:00 UTC)
// Sends a reminder only to clients who haven't submitted their check-in this week
//
// SETUP:
//   1. This file lives at api/send-reminders.js (already correct)
//   2. vercel.json must include the cron schedule (see vercel.json)
//   3. Add env var in Vercel: CRON_SECRET = any random string you choose
//      (used to protect the endpoint if triggered manually)

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
// Phase 1: cron uses the SERVICE ROLE key (bypasses RLS) so it keeps working
// after the v26 anon-policy lockdown. Server-side only — never sent to a browser.
const SUPABASE_KEY  = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON;
if (!SUPABASE_KEY) throw new Error('send-reminders.js: missing SUPABASE_SECRET_KEY — refusing to run cron with no service key');
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Record a successful cron run so detect_breakages can flag this job if it goes silent.
async function recordHeartbeat(name, status = 'ok', detail = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeats?on_conflict=cron_name`, {
      method:  'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cron_name: name, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail, updated_at: new Date().toISOString() }),
    });
  } catch (_) { /* best-effort */ }
}
const RESEND_FROM    = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE    = 'https://portal.gpsleadership.org/client.html';
const CRON_SECRET    = process.env.CRON_SECRET;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

// ── Editable copy (Communication > Templates) ────────────────────────────────
// Subject + body prose for outbound emails can be edited by the coach in the
// Templates UI. We fetch the approved row; if none exists we fall back to the
// hardcoded default at the call site, so a missing/un-approved row never breaks
// a send. Body markers (**bold** *italic* __underline__ "- " bullets "> " indent)
// match the Templates editor + the other send renderers.
const _tplCache = {};
async function getApprovedTemplate(key) {
  if (_tplCache[key] !== undefined) return _tplCache[key];
  let tpl = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/email_templates?template_key=eq.${encodeURIComponent(key)}&is_approved=eq.true&select=subject,body_text&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (r.ok) { const d = await r.json(); tpl = (Array.isArray(d) && d[0]) ? d[0] : null; }
  } catch (_) { tpl = null; }
  _tplCache[key] = tpl;
  return tpl;
}
function fillTemplate(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => (vars && vars[k] != null) ? String(vars[k]) : '');
}
function tplProse(text) {
  function inline(s) {
    return s
      .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '<span style="text-decoration:underline;">$1</span>')
      .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>');
  }
  const lines = String(text || '').split(/\n/);
  let html = '', buf = [];
  function flush() {
    if (buf.length) { html += '<ul style="margin:0 0 16px;padding-left:22px;">' + buf.map(li => `<li style="margin:0 0 6px;">${inline(li)}</li>`).join('') + '</ul>'; buf = []; }
  }
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    const b = l.match(/^[-*]\s+(.*)$/);
    if (b) { buf.push(b[1]); continue; }
    flush();
    const ind = l.match(/^>\s+(.*)$/);
    if (ind) { html += `<p style="margin:0 0 16px;padding-left:22px;">${inline(ind[1])}</p>`; continue; }
    html += `<p style="margin:0 0 16px;">${inline(l)}</p>`;
  }
  flush();
  return html;
}

// Verify a coach session token (HMAC) for authenticated manual cron triggers.
function verifyCoachSession(tok) {
  if (!tok || !COACH_SESSION_SECRET) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!p || p.role !== 'coach' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

// ── Date helper: parse "YYYY-MM-DD" as LOCAL midnight, not UTC ──────────────
// new Date("2026-03-16") parses as UTC → shows as Mar 15 in US timezones.
// This helper avoids that off-by-one error.
function parseLocalDate(str) {
  if (!str) return new Date();
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d); // local midnight
}

// ── Log an email send to the email_log table ─────────────────────────────────
async function logEmail({ clientId, recipientEmail, recipientName, emailType, subject, status, errorDetails, resendId }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/email_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        client_id:       clientId || null,
        recipient_email: recipientEmail,
        recipient_name:  recipientName || null,
        email_type:      emailType,
        subject:         subject || null,
        status,
        error_details:   errorDetails ? JSON.stringify(errorDetails) : null,
        resend_id:       resendId || null,
      }),
    });
  } catch (_) {
    // Logging failure should never break the main send flow
  }
}

export default async function handler(req, res) {
  // Allow GET (Vercel cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: verify cron secret (Vercel sets Authorization header automatically)
  const authHeader = req.headers['authorization'] || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  // Also accept POST from run-reminders-now.js (which handles its own auth)
  const isManualTrigger = req.method === 'POST' && !!verifyCoachSession(req.body?.session);

  if (!isVercelCron && !hasSecret && !isManualTrigger) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ─── FETCH ALL ACTIVE CLIENTS WITH A PLAN ──────────────────────────────────
  const clientsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&is_archived=eq.false&plan_start_date=not.is.null&email=not.is.null&select=id,name,email,token,plan_start_date`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const clients = await clientsRes.json();

  if (!Array.isArray(clients) || clients.length === 0) {
    await recordHeartbeat('send-reminders', 'ok', 'no active clients to remind');
    return res.status(200).json({ message: 'No active clients with email addresses found.', sent: 0, skipped: 0, errors: [] });
  }

  // ─── FETCH ALL CHECK-INS ────────────────────────────────────────────────────
  const checkinsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/checkins?select=client_id,week_number`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const checkins = await checkinsRes.json();

  // Build a lookup: Set of "clientId-weekNumber" for fast checking
  const submitted = new Set((checkins || []).map(c => `${c.client_id}-${c.week_number}`));

  // ─── DETERMINE WHO NEEDS A REMINDER ────────────────────────────────────────
  const today = new Date();
  const skipped = [];

  const toRemind = clients.filter(client => {
    const startDate  = parseLocalDate(client.plan_start_date); // fix UTC off-by-one
    const daysDiff   = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
    const currentWeek = Math.min(Math.max(Math.ceil((daysDiff + 1) / 7), 1), 12);

    // Only remind if engagement is in progress (weeks 1–12)
    if (currentWeek < 1 || currentWeek > 12) {
      skipped.push({ name: client.name, reason: `Week ${currentWeek} out of range` });
      return false;
    }

    // Only remind if they haven't submitted this week's check-in
    if (submitted.has(`${client.id}-${currentWeek}`)) {
      skipped.push({ name: client.name, reason: `Already submitted week ${currentWeek}` });
      return false;
    }

    return true;
  });

  if (toRemind.length === 0) {
    return res.status(200).json({
      message: 'All eligible clients have already checked in this week.',
      sent: 0,
      skipped,
      errors: [],
    });
  }

  // ─── SEND REMINDERS ────────────────────────────────────────────────────────
  let sent = 0;
  const errors = [];
  const sentList = [];

  for (const client of toRemind) {
    const startDate   = parseLocalDate(client.plan_start_date); // fix UTC off-by-one
    const daysDiff    = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
    const currentWeek = Math.min(Math.max(Math.ceil((daysDiff + 1) / 7), 1), 12);
    const firstName   = (client.name || '').split(' ')[0] || 'there';
    const portalLink  = `${PORTAL_BASE}?token=${client.token}`;

    // Editable copy: Communication > Templates, key "reminder_weekly_checkin".
    // Falls back to the original hardcoded copy if no approved row exists.
    const _tpl = await getApprovedTemplate('reminder_weekly_checkin');
    const _vars = { first_name: firstName, week: currentWeek };
    const subject = (_tpl && _tpl.subject)
      ? fillTemplate(_tpl.subject, _vars)
      : `Week ${currentWeek} check-in — a quick reminder, ${firstName}`;
    const bodyProse = (_tpl && _tpl.body_text)
      ? tplProse(fillTemplate(_tpl.body_text, _vars))
      : tplProse([
          `Hi ${firstName},`,
          `Just a quick heads-up — your Week ${currentWeek} check-in is ready for you.`,
          `It takes less than two minutes. Log your metric, note what you did this week, and set your action for next week. That's it.`,
          `The leaders who move fastest are the ones who stay honest with themselves weekly — not just on coaching calls.`,
        ].join('\n\n'));

    // Google Calendar recurring Monday event link
    const gcalTitle   = encodeURIComponent('GPS Leadership — Weekly Check-In');
    const gcalDetails = encodeURIComponent(`Complete your weekly GPS Leadership check-in at ${portalLink}`);
    const gcalDate    = (() => {
      const d = new Date(today);
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

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Week ${currentWeek} Check-In Reminder</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">

          ${bodyProse}

          <div style="margin:28px 0 0;text-align:center;">
            <a href="${portalLink}"
               style="background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
              Complete My Week ${currentWeek} Check-In →
            </a>
          </div>
          ${(() => { try { return require('./brand-link').pasteLink(portalLink, 'center'); } catch (_) { return ''; } })()}

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

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
          to:      [client.email],
          subject,
          html,
          text:    String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          reply_to: 'alex@gpsleadership.org',
        }),
      });

      const result = await emailRes.json();
      if (!emailRes.ok) {
        errors.push({ client: client.name, email: client.email, error: result });
        await logEmail({
          clientId: client.id,
          recipientEmail: client.email,
          recipientName: client.name,
          emailType: 'reminder',
          subject,
          status: 'error',
          errorDetails: result,
        });
      } else {
        sent++;
        sentList.push({ name: client.name, email: client.email, week: currentWeek });
        await logEmail({
          clientId: client.id,
          recipientEmail: client.email,
          recipientName: client.name,
          emailType: 'reminder',
          subject,
          status: 'sent',
          resendId: result.id,
        });
      }
    } catch (err) {
      errors.push({ client: client.name, email: client.email, error: err.message });
      await logEmail({
        clientId: client.id,
        recipientEmail: client.email,
        recipientName: client.name,
        emailType: 'reminder',
        subject,
        status: 'error',
        errorDetails: err.message,
      });
    }
  }

  await recordHeartbeat('send-reminders', 'ok', `sent ${sent} of ${toRemind.length}`);
  return res.status(200).json({
    message: `Reminders sent: ${sent} of ${toRemind.length}`,
    sent,
    sentList,
    skipped,
    errors: errors.length > 0 ? errors : [],
  });
}
