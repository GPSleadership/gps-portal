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
// FROM domain is PINNED (5E): a mis-set RESEND_FROM_EMAIL pointing at an
// unverified domain silently fails every send. Anything outside gpsleadership.org
// falls back to the verified default.
const RESEND_FROM_PINNED = 'noreply@portal.gpsleadership.org';
const RESEND_FROM    = /@(?:[a-z0-9-]+\.)*gpsleadership\.org$/i.test(String(process.env.RESEND_FROM_EMAIL || ''))
  ? process.env.RESEND_FROM_EMAIL
  : RESEND_FROM_PINNED;
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

// ── Personalized AI nudge (5D) ───────────────────────────────────────────────
// Two sentences in Alex's voice referencing the client's own last check-in,
// generated at send time with the fast model. FAIL OPEN: any miss (no key, flag
// off, timeout, API error, empty output) returns '' and the reminder sends
// without a nudge — generation can never block or delay the email meaningfully.
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const NUDGE_MODEL     = process.env.CLAUDE_FAST || 'claude-haiku-4-5-20251001';
const NUDGE_CAP       = Math.max(0, Number(process.env.REMINDER_NUDGE_CAP || 25)); // per-run cost/latency cap

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// AI kill-switch (coach Settings > AI Controls) — same fail-open semantics as
// diag-portal.js: only an explicit enabled=false turns the feature off.
async function aiFeatureEnabled(feature) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ai_feature_flags?feature=eq.${encodeURIComponent(feature)}&select=enabled&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!r.ok) return true;
    const row = (await r.json())[0];
    return !row || row.enabled !== false;
  } catch (_) { return true; }
}

async function generateNudge({ firstName, week, lastCheckin }) {
  if (!ANTHROPIC_KEY || !lastCheckin) return '';
  const facts = {
    first_name: firstName,
    upcoming_week: week,
    last_checkin_week: lastCheckin.week_number,
    last_commitment: (lastCheckin.planned_action || '').slice(0, 300) || null,
    last_completion_status: lastCheckin.completion_status || null,
    last_notes: (lastCheckin.notes || '').slice(0, 300) || null,
  };
  const sys = 'You write a short personal nudge from executive coach Alex Tremble inside a weekly check-in reminder email to his coaching client. '
    + 'Voice: direct, candid, calm, warm. Simple words, short sentences. '
    + 'Ground it in the client\'s most recent check-in: if they committed to an action, ask about that action specifically; '
    + 'if they were off track or partial, acknowledge it without judgment and point at one small next move; '
    + 'if they were on track, name the win and raise the bar slightly. '
    + 'Hard rules: 1-2 sentences, 45 words maximum, plain text only, no em dashes, no emojis, no exclamation marks, '
    + 'no greeting, no sign-off, never invent facts that are not in the data.';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: NUDGE_MODEL, max_tokens: 150, system: sys,
        messages: [{ role: 'user', content: 'Client check-in data:\n' + JSON.stringify(facts) }] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return '';
    const j = await r.json();
    let txt = (j.content && j.content[0] && j.content[0].text) || '';
    // Guardrail cleanup: strip wrapping quotes, replace any em/en dash that slipped
    // through (brand rule: no em dashes in client-facing copy), collapse whitespace.
    txt = String(txt).trim().replace(/^["'“]+|["'”]+$/g, '')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .slice(0, 400).trim();
    if (txt.length < 15) return '';   // too short to be a real nudge
    return txt;
  } catch (_) { return ''; }
}

// ── Scheduled-draft failure handling (5E) ────────────────────────────────────
// Mirrors recordDraftFailure in api/diagnostic.js: stamp attempts + last_error on
// the email_drafts row; at DRAFT_MAX_ATTEMPTS flip it to status='failed' (out of
// every sweep) and raise a P1 cio_findings row so the daily brief surfaces it.
const DRAFT_MAX_ATTEMPTS = 5;
async function recordDraftFailure(draftId, errMsg) {
  const hdrs = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/email_drafts?id=eq.${encodeURIComponent(draftId)}&select=attempts,email_key,to_email&limit=1`, { headers: hdrs });
    const row = (r.ok ? await r.json() : [])[0] || {};
    const n = (Number(row.attempts) || 0) + 1;
    const capped = n >= DRAFT_MAX_ATTEMPTS;
    await fetch(`${SUPABASE_URL}/rest/v1/email_drafts?id=eq.${encodeURIComponent(draftId)}`, {
      method: 'PATCH', headers: { ...hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify({
        attempts: n,
        last_error: String(errMsg || 'send failed').slice(0, 500),
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(capped ? { status: 'failed' } : {}),
      }),
    });
    if (capped) {
      await fetch(`${SUPABASE_URL}/rest/v1/cio_findings?on_conflict=dedupe_key`, {
        method: 'POST', headers: { ...hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          dedupe_key: 'email_draft_fail:' + draftId,
          category: 'reliability', severity: 'P1',
          title: 'Scheduled email gave up after ' + n + ' attempts: ' + (row.email_key || 'draft'),
          detail: 'email_drafts ' + draftId + ' (' + (row.email_key || '?') + ' to ' + (row.to_email || '?')
            + ') failed ' + n + ' times and was marked failed. Last error: ' + String(errMsg || '').slice(0, 300),
          recommendation: 'Check Resend domain/API status and email_drafts.last_error, fix the cause, then reschedule the draft or send it manually from the coach dashboard.',
          source: 'send-reminders', status: 'open',
          first_seen: new Date().toISOString(), last_seen: new Date().toISOString(),
        }),
      });
    }
    return { attempts: n, capped };
  } catch (_) { return { attempts: null, capped: false }; }
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

  // ─── ACTION: milestones — 30/90-day reminders at T-5 and day-of ─────────────
  // Mirrors the weekly sweep: active clients with a start date + email; compute each
  // milestone's target date; send once at T-5 and once day-of, stamping the matching
  // milestone_*_sent_at ONLY after a confirmed send (quota-safe, no silent dupes).
  // Sponsored vs self copy diverges only on the 90-day 5-day-out note. Day-of is
  // skipped when the goal is already hit (the celebration modal covers that).
  if (action === 'milestones') {
    try {
      const clientsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&is_archived=eq.false&email=not.is.null&select=id,name,email,token,coaching_program_start_date,plan_start_date,metric_target,metric_current,goal_30_day,goal_90_day,goal_statement,sponsor_outcome_focus,milestone_30_5day_sent_at,milestone_30_dayof_sent_at,milestone_90_5day_sent_at,milestone_90_dayof_sent_at`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const clients = clientsRes.ok ? await clientsRes.json() : [];
      if (!Array.isArray(clients) || clients.length === 0) {
        await recordHeartbeat('send-milestones', 'ok', 'no active clients');
        return res.status(200).json({ sent: 0 });
      }

      const FALLBACK = {
        milestone_30_5day: {
          subject: 'Your 30-day goal is 5 days away',
          body: 'Your 30-day goal is 5 days away: "{{goal_30}}". This isn\'t a grade — it\'s your window to adjust while there\'s still time. One question: if the mark were today, would you have hit it? If yes, name what made it work so you keep doing it. If not, pick the one move you can still make in the next 5 days — and put it on your calendar now.',
        },
        milestone_30_dayof: {
          subject: 'Today is your 30-day mark',
          body: 'Today is your 30-day mark. The goal you set: "{{goal_30}}". Two minutes, straight answer: hit it, missed it, or somewhere in between? Log it in this week\'s check-in — what moved it, and what got in the way. Honest at 30 is what makes 90 possible.',
        },
        milestone_90_5day_sponsored: {
          subject: '5 days to your 90-day goal',
          body: 'Five days to your 90-day goal — the one your sponsor is watching: "{{goal_90}}". Get ahead of it now. What result can you point to, and what backs it up? If there\'s a gap between where you are and what you committed to, name it before the date — a gap you surface is a coaching conversation; a gap you hide is a surprise. Then make the one move that closes the most ground in the next 5 days.',
        },
        milestone_90_5day_self: {
          subject: '5 days to your 90-day goal',
          body: 'Five days to your 90-day goal — the number you set out to move: "{{goal_90}}". Get ahead of it now. What result can you point to, and what backs it up? If there\'s a gap between where you are and what you committed to, name it before the date — a gap you surface is a coaching conversation; a gap you bury just costs you the result you\'re paying for. Then make the one move that closes the most ground in the next 5 days.',
        },
        milestone_90_dayof: {
          subject: 'Today is your 90-day mark',
          body: 'Today is your 90-day mark. The goal you set 90 days ago: "{{goal_90}}". Log what you delivered against it — wins and misses, plainly. Then two questions: what would the people around you say changed over these 90 days? And what\'s worth building next? This is a checkpoint, not a verdict — the point is what you do with it.',
        },
      };

      const todayM = new Date(); todayM.setHours(0, 0, 0, 0);
      const DAYMS = 86400000;
      let sent = 0; const errs = []; const sentList = [];

      for (const client of clients) {
        const startStr = client.coaching_program_start_date || client.plan_start_date;
        if (!startStr) continue;
        const start = parseLocalDate(startStr); start.setHours(0, 0, 0, 0);
        if (isNaN(start)) continue;
        const firstName = (client.name || '').split(' ')[0] || 'there';
        const portalLink = `${PORTAL_BASE}?token=${client.token}`;
        const target = client.metric_target != null ? Number(client.metric_target) : null;
        const current = client.metric_current != null ? Number(client.metric_current) : null;
        const hit = (target != null && current != null && !isNaN(target) && !isNaN(current) && current >= target);
        const sponsored = client.sponsor_outcome_focus === true;
        const goal30 = client.goal_30_day || '';
        const goal90 = client.goal_90_day || client.goal_statement || '';

        const phases = [
          { days: 30, goalText: goal30, t5Key: 'milestone_30_5day', t5Col: 'milestone_30_5day_sent_at', dofKey: 'milestone_30_dayof', dofCol: 'milestone_30_dayof_sent_at' },
          { days: 90, goalText: goal90, t5Key: sponsored ? 'milestone_90_5day_sponsored' : 'milestone_90_5day_self', t5Col: 'milestone_90_5day_sent_at', dofKey: 'milestone_90_dayof', dofCol: 'milestone_90_dayof_sent_at' },
        ];

        for (const ph of phases) {
          const targetDate = new Date(start.getTime() + ph.days * DAYMS);
          const daysUntil = Math.round((targetDate - todayM) / DAYMS);
          let window = null, key = null, stampCol = null;
          if (daysUntil === 5)      { window = 't5';    key = ph.t5Key;  stampCol = ph.t5Col; }
          else if (daysUntil === 0) { window = 'dayof'; key = ph.dofKey; stampCol = ph.dofCol; }
          if (!window) continue;
          if (window === 'dayof' && hit) continue;   // a hit is celebrated, not reminded
          if (client[stampCol]) continue;            // already sent this reminder
          if (!ph.goalText) continue;                // no goal text → nothing to send

          const gvar = ph.days === 30 ? { goal_30: ph.goalText, first_name: firstName } : { goal_90: ph.goalText, first_name: firstName };
          const tpl = await getApprovedTemplate(key);
          const fb = FALLBACK[key];
          const subject = (tpl && tpl.subject) ? fillTemplate(tpl.subject, gvar) : fillTemplate(fb.subject, gvar);
          const bodyProse = (tpl && tpl.body_text) ? tplProse(fillTemplate(tpl.body_text, gvar)) : tplProse(fillTemplate(fb.body, gvar));

          const html = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
              <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
                <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
                <div style="color:#ffffff;font-size:20px;font-weight:700;">${subject}</div>
              </div>
              <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
                ${bodyProse}
                <div style="text-align:center;margin:24px 0 8px;">
                  <a href="${portalLink}" style="background:#DB1F48;color:#ffffff;text-decoration:none;padding:14px 30px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Open my check-in →</a>
                </div>
                <p style="margin-top:28px;">– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
                <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;">You're receiving this because you have an active engagement with GPS Leadership.</div>
              </div>
            </div>`;

          if (!RESEND_API_KEY) continue;
          try {
            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
                to: [client.email],
                subject,
                html,
                text: String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                reply_to: 'alex@gpsleadership.org',
              }),
            });
            const result = await emailRes.json();
            if (!emailRes.ok) {
              errs.push({ client: client.name, key, error: result });
              await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'milestone', subject, status: 'error', errorDetails: result });
            } else {
              sent++; sentList.push({ name: client.name, key });
              await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'milestone', subject, status: 'sent', resendId: result.id });
              const nowIso = new Date().toISOString();
              await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${client.id}`, {
                method: 'PATCH',
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ [stampCol]: nowIso }),
              });
              client[stampCol] = nowIso; // guard against a double-send within this same run
            }
          } catch (err) {
            errs.push({ client: client.name, key, error: err.message });
            await logEmail({ clientId: client.id, recipientEmail: client.email, recipientName: client.name, emailType: 'milestone', subject, status: 'error', errorDetails: err.message });
          }
        }
      }

      await recordHeartbeat('send-milestones', 'ok', `sent ${sent}${errs.length ? '; ' + errs.length + ' errors' : ''}`);
      return res.status(200).json({ sent, errors: errs, sentList });
    } catch (err) {
      await recordHeartbeat('send-milestones', 'error', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── FETCH ALL ACTIVE CLIENTS WITH A PLAN ──────────────────────────────────
  const clientsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&is_archived=eq.false&plan_start_date=not.is.null&email=not.is.null&select=id,name,email,token,plan_start_date,phone,sms_opt_in`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const clients = await clientsRes.json();

  if (!Array.isArray(clients) || clients.length === 0) {
    await recordHeartbeat('send-reminders', 'ok', 'no active clients to remind');
    return res.status(200).json({ message: 'No active clients with email addresses found.', sent: 0, skipped: 0, errors: [] });
  }

  // ─── FETCH ALL CHECK-INS ────────────────────────────────────────────────────
  // Also pulls each check-in's substance (commitment, status, notes) so the
  // personalized nudge (5D) can reference the client's own last check-in.
  const checkinsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/checkins?select=client_id,week_number,planned_action,completion_status,notes,submitted_at`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const checkins = await checkinsRes.json();

  // Build a lookup: Set of "clientId-weekNumber" for fast checking
  const submitted = new Set((checkins || []).map(c => `${c.client_id}-${c.week_number}`));

  // Latest check-in per client (by submitted_at) — feeds the personalized nudge.
  const lastCheckinByClient = {};
  for (const c of (Array.isArray(checkins) ? checkins : [])) {
    const prev = lastCheckinByClient[c.client_id];
    if (!prev || String(c.submitted_at || '') > String(prev.submitted_at || '')) lastCheckinByClient[c.client_id] = c;
  }

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
  let smsSent = 0;                 // opt-in SMS reminders sent this run
  const smsErrors = [];            // real SMS failures (skips are not errors)
  const { sendSms } = require('./twilio-sms');

  // ── Tool of the Week (5C) ───────────────────────────────────────────────────
  // One tool from the portal library per ISO week, deterministic rotation
  // (api/tools-catalog.js) — same tool for every client that week, advances
  // weekly, wraps the list. Coach can PIN a tool without a deploy: approve a
  // 'tool_of_week_override' row in Communication > Templates whose body_text is
  // the tool id (e.g. t_brave). Best-effort: any failure just omits the block.
  let toolOfWeek = null;
  try {
    const { toolOfTheWeek, toolById } = require('./tools-catalog');
    const ovTpl = await getApprovedTemplate('tool_of_week_override');
    toolOfWeek = (ovTpl && ovTpl.body_text && toolById(String(ovTpl.body_text).trim())) || toolOfTheWeek();
  } catch (_) { toolOfWeek = null; }

  // ── Personalized nudge (5D): checked once per run; capped per run ───────────
  const nudgeEnabled = NUDGE_CAP > 0 && await aiFeatureEnabled('reminder_nudge');
  let nudgesGenerated = 0;

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

    // Personalized nudge (5D) — references THIS client's last check-in. Fail open:
    // '' on any miss, and the reminder is never blocked or delayed past the timeout.
    let nudgeHtml = '';
    if (nudgeEnabled && nudgesGenerated < NUDGE_CAP && lastCheckinByClient[client.id]) {
      const nudgeText = await generateNudge({ firstName, week: currentWeek, lastCheckin: lastCheckinByClient[client.id] });
      if (nudgeText) {
        nudgesGenerated++;
        nudgeHtml = `
          <div style="margin:18px 0 0;padding:14px 18px;background:#f7f4ee;border-left:3px solid #C09A2A;border-radius:0 8px 8px 0;font-size:14px;color:#1a2a3a;line-height:1.65;">
            <span style="font-weight:700;color:#004369;">From Alex:</span> ${escHtml(nudgeText)}
          </div>`;
      }
    }

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
          ${nudgeHtml}

          <div style="margin:28px 0 0;text-align:center;">
            <p style="font-size:14px;color:#333333;margin:0 0 12px;font-weight:600;">How's this week landing? Tap one to start your check-in:</p>
            <a href="${portalLink}&checkin=on_track" style="display:inline-block;background:#157347;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:700;margin:4px;">On track</a>
            <a href="${portalLink}&checkin=partial" style="display:inline-block;background:#8F560F;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:700;margin:4px;">Partial</a>
            <a href="${portalLink}&checkin=off_track" style="display:inline-block;background:#DC2626;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:700;margin:4px;">Off track</a>
          </div>
          <div style="margin:14px 0 0;text-align:center;">
            <a href="${portalLink}"
               style="background:#004369;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
              Complete My Week ${currentWeek} Check-In →
            </a>
          </div>
          ${(() => { try { return require('./brand-link').pasteLink(portalLink, 'center'); } catch (_) { return ''; } })()}

          ${toolOfWeek ? `
          <div style="margin-top:26px;padding:16px 20px;background:#f0f9f9;border-left:3px solid #01949A;border-radius:0 8px 8px 0;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#01949A;margin-bottom:6px;">Tool of the Week</div>
            <div style="font-size:15px;font-weight:700;color:#004369;margin-bottom:4px;">${toolOfWeek.name}</div>
            <div style="font-size:13px;color:#555555;line-height:1.6;margin-bottom:10px;">${toolOfWeek.desc}</div>
            <a href="${portalLink}&tab=resources" style="color:#004369;font-size:13px;font-weight:700;text-decoration:none;">Open it in your portal →</a>
          </div>` : ''}

          <div style="margin-top:16px;padding:16px 20px;background:#f7f4ee;border-radius:8px;text-align:center;">
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

    // ─── SMS reminder (opt-in only) ─────────────────────────────────────────
    // Message text AND on/off both live in Communication > Templates, in the
    // `reminder_weekly_checkin_sms` row: edit body_text to change the wording,
    // toggle "Approved" to turn SMS reminders on or off. There is NO hardcoded
    // fallback — if no APPROVED template exists, no SMS is sent (that is the off
    // switch). Vars: {{first_name}}, {{week}}, {{link}}.
    // Non-blocking: an SMS failure never affects the email path. No-ops cleanly
    // until Twilio env vars are set. STOP/HELP handled by the Messaging Service.
    if (client.sms_opt_in && client.phone) {
      try {
        const smsTpl = await getApprovedTemplate('reminder_weekly_checkin_sms');
        if (smsTpl && smsTpl.body_text && smsTpl.body_text.trim()) {
          const smsBody = fillTemplate(smsTpl.body_text, { first_name: firstName, week: currentWeek, link: portalLink });
          const smsRes = await sendSms({ to: client.phone, body: smsBody });
          if (smsRes.ok) smsSent++;
          else if (!smsRes.skipped) smsErrors.push({ client: client.name, error: smsRes.error || smsRes.code });
        }
      } catch (smsErr) {
        smsErrors.push({ client: client.name, error: smsErr.message });
      }
    }
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
        // A draft with no recipient can never succeed — count it toward the cap so
        // it flips to 'failed' instead of resurfacing on every pass forever.
        const fr = await recordDraftFailure(draft.id, 'no to_email');
        draftsErrors.push({ id: draft.id, error: 'no to_email', attempts: fr.attempts, gave_up: fr.capped });
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
          const fr = await recordDraftFailure(draft.id, JSON.stringify(sendResult).slice(0, 300));
          draftsErrors.push({ id: draft.id, email_key: draft.email_key, error: sendResult, attempts: fr.attempts, gave_up: fr.capped });
          await logEmail({
            clientId: null, recipientEmail: draft.to_email, recipientName: draft.to_name || '',
            emailType: 'seq_' + String(draft.email_key || '').toLowerCase(),
            subject: draft.subject || '', status: 'error', errorDetails: sendResult,
          });
        }
      } catch (draftErr) {
        const fr = await recordDraftFailure(draft.id, draftErr.message);
        draftsErrors.push({ id: draft.id, email_key: draft.email_key, error: draftErr.message, attempts: fr.attempts, gave_up: fr.capped });
      }
    }
  } catch (seqErr) {
    draftsErrors.push({ error: 'Email sequence sweep failed: ' + seqErr.message });
  }

  await recordHeartbeat('send-reminders', 'ok', `sent ${sent} of ${toRemind.length}; sms=${smsSent}; seq=${draftsSent.length}`);
  return res.status(200).json({
    message: `Reminders sent: ${sent} of ${toRemind.length}`,
    sent,
    sentList,
    skipped,
    errors: errors.length > 0 ? errors : [],
    sms: { sent: smsSent, errors: smsErrors.length > 0 ? smsErrors : [] },
    email_sequence: { sent: draftsSent.length, errors: draftsErrors.length > 0 ? draftsErrors : [] },
  });
}
