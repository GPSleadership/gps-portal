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

// ── Count weekday-only business days since a UTC timestamp ─────────────────
function businessDaysSince(fromIso) {
  if (!fromIso) return 0;
  const from = new Date(fromIso);
  if (isNaN(from)) return 0;
  const cur = new Date(from); cur.setHours(0, 0, 0, 0);
  const end = new Date();     end.setHours(0, 0, 0, 0);
  let count = 0;
  while (cur < end) { cur.setDate(cur.getDate() + 1); const d = cur.getDay(); if (d !== 0 && d !== 6) count++; }
  return count;
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

  const action = (req.query && req.query.action) || '';

  // ─── ACTION: msg-overdue — daily M–F escalation for unreplied client messages
  // Fires at 0 12 * * 1-5 (noon UTC = 8am ET). Finds every open conversation
  // where the last message is from a client and >= 1 business day has passed
  // without a coach reply, then sends a red escalation email to alex.
  if (action === 'msg-overdue') {
    try {
      const COACH_EMAIL = 'alex@gpsleadership.org';

      // 1. Fetch all non-closed conversations
      const convRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_conversations?status=neq.closed&select=id,client_id,last_message_at`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const convs = convRes.ok ? await convRes.json() : [];

      if (!Array.isArray(convs) || convs.length === 0) {
        await recordHeartbeat('msg-overdue', 'ok', 'no open conversations');
        return res.status(200).json({ overdue: 0 });
      }

      const convIds = convs.map(c => c.id);

      // 2. Bulk-fetch messages for those conversations (sorted desc — first row per conv = last message)
      const msgsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_messages?conversation_id=in.(${convIds.join(',')})&select=conversation_id,sender_role,message_text,created_at&order=created_at.desc&limit=1000`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const msgs = msgsRes.ok ? await msgsRes.json() : [];

      // Keep only the last message per conversation (msgs already desc)
      const lastMsg = {};
      for (const m of (Array.isArray(msgs) ? msgs : [])) {
        if (!lastMsg[m.conversation_id]) lastMsg[m.conversation_id] = m;
      }

      // 3. Fetch client names
      const clientIds = [...new Set(convs.map(c => c.client_id).filter(Boolean))];
      const clientMap = {};
      if (clientIds.length) {
        const clRes = await fetch(
          `${SUPABASE_URL}/rest/v1/clients?id=in.(${clientIds.join(',')})&select=id,name`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const clRows = clRes.ok ? await clRes.json() : [];
        for (const cl of (Array.isArray(clRows) ? clRows : [])) clientMap[cl.id] = cl.name;
      }

      // 4. Filter: last message from client AND >= 1 business day without reply
      const overdue = convs
        .filter(c => {
          const last = lastMsg[c.id];
          return last && last.sender_role === 'client' && businessDaysSince(last.created_at) >= 1;
        })
        .map(c => {
          const last = lastMsg[c.id];
          const days = businessDaysSince(last.created_at);
          const preview = (last.message_text || '').replace(/\s+/g, ' ').trim().slice(0, 130);
          return { id: c.id, clientName: clientMap[c.client_id] || 'Unknown client', days, preview };
        })
        .sort((a, b) => b.days - a.days);

      if (overdue.length === 0) {
        await recordHeartbeat('msg-overdue', 'ok', 'no overdue messages');
        return res.status(200).json({ overdue: 0 });
      }

      // 5. Send consolidated escalation email to coach
      const subject = overdue.length === 1
        ? `⚠️ OVERDUE (${overdue[0].days}d): ${overdue[0].clientName} is still waiting on your reply`
        : `⚠️ OVERDUE: ${overdue.length} clients waiting on your reply`;

      const tableRows = overdue.map(o =>
        `<tr>`
        + `<td style="padding:10px 14px;border-bottom:1px solid #f0d0d0;font-weight:700;color:#1a1a1a;font-size:14px;">${o.clientName}</td>`
        + `<td style="padding:10px 14px;border-bottom:1px solid #f0d0d0;text-align:center;"><span style="background:#C0392B;color:#fff;border-radius:5px;padding:2px 10px;font-size:12px;font-weight:700;">${o.days} day${o.days !== 1 ? 's' : ''}</span></td>`
        + `<td style="padding:10px 14px;border-bottom:1px solid #f0d0d0;font-size:13px;color:#555;">${o.preview ? o.preview.replace(/</g, '&lt;').replace(/>/g, '&gt;') + (o.preview.length >= 130 ? '…' : '') : '<em>No preview</em>'}</td>`
        + `</tr>`
      ).join('');

      const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#C0392B;padding:18px 24px;border-radius:8px 8px 0 0;">
          <div style="color:#ffdddd;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership — Coach Alert</div>
          <div style="color:#fff;font-size:20px;font-weight:700;">⚠️ Overdue Client Repl${overdue.length > 1 ? 'ies' : 'y'}</div>
        </div>
        <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:2px solid #C0392B;border-top:none;">
          <p style="margin:0 0 16px;font-size:15px;">The following client${overdue.length > 1 ? 's are' : ' is'} waiting on a reply for <strong>more than 1 business day</strong>. They sent you a message and haven't heard back.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-radius:6px;overflow:hidden;border:1px solid #f0d0d0;">
            <thead><tr style="background:#C0392B;">
              <th style="padding:10px 14px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Client</th>
              <th style="padding:10px 14px;text-align:center;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Days Overdue</th>
              <th style="padding:10px 14px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Last Message</th>
            </tr></thead>
            <tbody style="background:#FEF2F2;">${tableRows}</tbody>
          </table>
          <div style="text-align:center;">
            <a href="https://portal.gpsleadership.org/coach" style="background:#C0392B;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Open Coach Dashboard &amp; Reply →</a>
          </div>
          <p style="margin:24px 0 0;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;">This alert fires every weekday when a client message goes unanswered for more than 1 business day.</p>
        </div>
      </div>`;

      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:  `GPS Leadership Portal <${RESEND_FROM}>`,
            to:    [COACH_EMAIL],
            subject,
            html,
            text: overdue.map(o => `${o.clientName} — ${o.days} day(s) overdue: ${o.preview}`).join('\n')
                  + '\n\nReply at: https://portal.gpsleadership.org/coach',
          }),
        });
      }

      await recordHeartbeat('msg-overdue', 'ok', `${overdue.length} overdue: ${overdue.map(o => o.clientName).join(', ')}`);
      return res.status(200).json({ overdue: overdue.length, clients: overdue.map(o => o.clientName) });

    } catch (err) {
      await recordHeartbeat('msg-overdue', 'error', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── FOLLOW-UP REMINDER: email anyone who still hasn't submitted mid-week ────
  // Previously Thursday-only via cron; now config-driven (followup_day_of_week /
  // followup_hour_utc). Fires when action='checkin-thursday' (legacy) OR when the
  // hourly cron hits the configured follow-up window.
  if (isFollowupWindow || action === 'checkin-thursday') {
    try {
      const thuClientsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&is_archived=eq.false&plan_start_date=not.is.null&email=not.is.null&select=id,name,email,token,plan_start_date`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const thuClients = thuClientsRes.ok ? await thuClientsRes.json() : [];
      if (!Array.isArray(thuClients) || thuClients.length === 0) {
        await recordHeartbeat('checkin-thursday', 'ok', 'no active clients');
        return res.status(200).json({ message: 'No active clients.', sent: 0 });
      }

      const thuCheckinsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/checkins?select=client_id,week_number`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const thuCheckins = thuCheckinsRes.ok ? await thuCheckinsRes.json() : [];
      const thuSubmitted = new Set((thuCheckins || []).map(c => `${c.client_id}-${c.week_number}`));

      const thuToday = new Date();
      let thuSent = 0;
      const thuErrors = [];

      for (const client of thuClients) {
        const startDate  = parseLocalDate(client.plan_start_date);
        const daysDiff   = Math.floor((thuToday - startDate) / (1000 * 60 * 60 * 24));
        const currentWeek = Math.min(Math.max(Math.ceil((daysDiff + 1) / 7), 1), 12);
        if (currentWeek < 1 || currentWeek > 12) continue;
        if (thuSubmitted.has(`${client.id}-${currentWeek}`)) continue; // already done

        const firstName  = (client.name || '').split(' ')[0] || 'there';
        const portalLink = `${PORTAL_BASE}?token=${client.token}`;
        const _tpl = await getApprovedTemplate('reminder_weekly_checkin_thursday');
        const _vars = { first_name: firstName, week: currentWeek };
        const subject = (_tpl && _tpl.subject)
          ? fillTemplate(_tpl.subject, _vars)
          : `Still time — Week ${currentWeek} check-in, ${firstName}`;
        const bodyProse = (_tpl && _tpl.body_text)
          ? tplProse(fillTemplate(_tpl.body_text, _vars))
          : tplProse([
              `Hi ${firstName},`,
              `Quick note — your Week ${currentWeek} check-in is still open. If you get to it today it counts.`,
              `60–90 seconds. Log your metric, note your win or stall, set your action for next week.`,
            ].join('\n\n'));

        const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
          <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
            <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
            <div style="color:#ffffff;font-size:20px;font-weight:700;">Week ${currentWeek} — Still Open</div>
          </div>
          <div style="padding:28px;background:#ffffff;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
            ${bodyProse}
            <div style="margin:28px 0 0;text-align:center;">
              <a href="${portalLink}" style="background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
                Complete My Week ${currentWeek} Check-In →
              </a>
            </div>
          </div>
        </div>`;

        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
              to: [client.email],
              subject,
              html,
              text: String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
              reply_to: 'alex@gpsleadership.org',
            }),
          });
          const result = await r.json();
          if (!r.ok) {
            thuErrors.push({ client: client.name, error: result });
            await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'reminder_thursday', subject, status: 'error', errorDetails: result });
          } else {
            thuSent++;
            await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'reminder_thursday', subject, status: 'sent', resendId: result.id });
          }
        } catch (err) {
          thuErrors.push({ client: client.name, error: err.message });
          await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'reminder_thursday', subject, status: 'error', errorDetails: err.message });
        }
      }

      await recordHeartbeat('checkin-thursday', 'ok', `sent: ${thuSent}, errors: ${thuErrors.length}`);
      return res.status(200).json({ sent: thuSent, errors: thuErrors });
    } catch (err) {
      await recordHeartbeat('checkin-thursday', 'error', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── SMS + EMAIL REMINDERS (config-driven, previously Monday-only) ──────────
  // Gate: runs when the global SMS window matches (config day+hour) OR when it's
  // the configured reminder hour on any day — per-client checkin_day filtering below
  // determines which clients actually get a reminder on non-global days.
  // action='checkin-sms' bypasses the gate for manual/legacy triggers.
  const isReminderHour = cfg.sms_enabled && hourUtc === cfg.sms_hour_utc;

  if (!isSmsWindow && !isReminderHour && action !== 'checkin-sms') {
    return res.status(200).json({ message: 'No matching reminder window for this hour.', skipped: true });
  }

  // ─── FETCH ALL ACTIVE CLIENTS WITH A PLAN (SMS + email handler) ──────────
  const clientsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&is_archived=eq.false&plan_start_date=not.is.null&email=not.is.null&select=id,name,email,token,plan_start_date,phone,checkin_day,at_risk`,
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

    // Per-client day check: if the client committed to a specific checkin_day, only
    // remind on that day. Clients without a checkin_day fall back to the global window.
    if (client.checkin_day) {
      const DAY_MAP = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
      const clientDayNum = DAY_MAP[client.checkin_day.toLowerCase()];
      if (clientDayNum === undefined || dayUtc !== clientDayNum) {
        skipped.push({ name: client.name, reason: 'Not their checkin_day (' + client.checkin_day + ')' });
        return false;
      }
    } else if (!isSmsWindow) {
      // No committed day and not the global SMS window — skip this client
      skipped.push({ name: client.name, reason: 'No checkin_day set; not global SMS window' });
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

  // ─── AT-RISK DETECTION ────────────────────────────────────────────────────
  // Flag clients who missed 2+ consecutive weeks. The at_risk flag auto-clears
  // server-side in portal-data.js submit-checkin when they submit a check-in.
  // Runs on every reminder pass so the flag is set even for non-reminder-day clients.
  try {
    const nowDetect = new Date();
    for (const client of clients) {
      if (client.at_risk) continue; // already flagged — don't spam Alex
      const sd = parseLocalDate(client.plan_start_date);
      const dd = Math.floor((nowDetect - sd) / (1000 * 60 * 60 * 24));
      const cw = Math.min(Math.max(Math.ceil((dd + 1) / 7), 1), 12);
      if (cw < 3) continue; // need at least week 3 to have missed 2 consecutive weeks
      const missedCurrent  = !submitted.has(`${client.id}-${cw}`);
      const missedPrevious = !submitted.has(`${client.id}-${cw - 1}`);
      if (!missedCurrent || !missedPrevious) continue;

      // Mark at-risk in DB
      await fetch(
        `${SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`,
        {
          method: 'PATCH',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ at_risk: true }),
        }
      );

      // Alert Alex
      const alertSubject = 'At-risk: ' + client.name + ' missed week ' + (cw - 1) + ' and ' + cw;
      const alertHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;color:#1a1a1a;">'
        + '<div style="background:#DB1F48;padding:16px 24px;border-radius:8px 8px 0 0;">'
        + '<div style="color:#fff;font-size:18px;font-weight:700;">At-Risk Alert</div></div>'
        + '<div style="background:#fff;padding:24px;border:1px solid #d0d0d0;border-top:none;border-radius:0 0 8px 8px;">'
        + '<p><strong>' + client.name + '</strong> missed check-ins for Week ' + (cw - 1) + ' and Week ' + cw + ' of their 90-day engagement.</p>'
        + '<p>Consider reaching out directly. This flag clears automatically when they submit a check-in.</p>'
        + '</div></div>';
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `GPS Leadership System <${RESEND_FROM}>`,
          to: ['alex@gpsleadership.org'],
          subject: alertSubject,
          html: alertHtml,
          text: client.name + ' missed week ' + (cw - 1) + ' and week ' + cw + '. Consider reaching out.',
        }),
      });
    }
  } catch (atRiskErr) {
    console.error('[send-reminders] at-risk detection failed:', atRiskErr.message);
  }

  // ─── SEND SCHEDULED EMAIL DRAFTS ──────────────────────────────────────────
  // Each cron pass delivers any email_drafts rows where:
  //   status = 'scheduled'  AND  scheduled_for <= now()
  // After sending, status is updated to 'sent' and sent_at is recorded.
  const draftsSent = [];
  const draftsErrors = [];
  try {
    const now = new Date();
    const draftsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/email_drafts?status=eq.scheduled&scheduled_for=lte.${encodeURIComponent(now.toISOString())}&select=id,diagnostic_id,email_key,sequence,subject,body,to_name,to_email&limit=50`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const dueDrafts = draftsRes.ok ? await draftsRes.json() : [];

    for (const draft of (Array.isArray(dueDrafts) ? dueDrafts : [])) {
      if (!draft.to_email) {
        draftsErrors.push({ id: draft.id, error: 'no to_email' });
        continue;
      }

      const bodyHtml = tplProse(draft.body || '');
      const titleMap = {
        E1:  'Preparing for our call tomorrow',
        E1b: 'Following up on our debrief',
        E2:  'A note before tomorrow',
        E3:  'Where things stand after the debrief',
        E4:  'The recommendations that shape the sprint',
        E5:  'Quick reminder — sprint window closing',
        E6:  'Last day to lock in the sprint',
        E7:  'Checking in on the development plan',
      };
      const title = titleMap[draft.email_key] || 'GPS Leadership Solutions';
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">${title}</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          ${bodyHtml}
          <p style="margin-top:28px;">– Alex Tremble<br><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
          <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;">
            Questions? Reply to this email or reach out to alex@gpsleadership.org.
          </div>
        </div>
      </div>`;

      try {
        const sendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
            to: [draft.to_email],
            subject: draft.subject || 'A note from Alex at GPS Leadership',
            html,
            text: String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            reply_to: 'alex@gpsleadership.org',
          }),
        });
        const sendResult = await sendRes.json();
        const sentAt = new Date().toISOString();
        if (sendRes.ok) {
          await fetch(`${SUPABASE_URL}/rest/v1/email_drafts?id=eq.${draft.id}`, {
            method: 'PATCH',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'sent', sent_at: sentAt, updated_at: sentAt }),
          });
          draftsSent.push({ id: draft.id, email_key: draft.email_key, to: draft.to_email });
          await logEmail({
            clientId: null, recipientEmail: draft.to_email, recipientName: draft.to_name || '',
            emailType: 'seq_' + String(draft.email_key || '').toLowerCase(),
            subject: draft.subject || '', status: 'sent', resendId: sendResult.id || null,
          });
        } else {
          draftsErrors.push({ id: draft.id, email_key: draft.email_key, error: sendResult });
          await logEmail({
            clientId: null, recipientEmail: draft.to_email, recipientName: draft.to_name || '',
            emailType: 'seq_' + String(draft.email_key || '').toLowerCase(),
            subject: draft.subject || '', status: 'error', errorDetails: sendResult,
          });
        }
      } catch (draftErr) {
        draftsErrors.push({ id: draft.id, email_key: draft.email_key, error: draftErr.message });
      }
    }
  } catch (seqErr) {
    draftsErrors.push({ error: 'Email sequence sweep failed: ' + seqErr.message });
  }

  await recordHeartbeat('send-reminders', 'ok', `sent ${sent} of ${toRemind.length}; seq=${draftsSent.length}`);
  return res.status(200).json({
    message: `Reminders sent: ${sent} of ${toRemind.length}`,
    sent,
    sentList,
    skipped,
    errors: errors.length > 0 ? errors : [],
    email_sequence: { sent: draftsSent.length, errors: draftsErrors.length > 0 ? draftsErrors : [] },
  });
}
