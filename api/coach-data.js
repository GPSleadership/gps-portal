// GPS Leadership — Coach Dashboard Data API (Phase 1 hardening, HYBRID model)
//
// Every request must carry a valid coach SESSION token (issued by
// /api/get-client?action=coach-login). With a valid session, the coach gets:
//   • a GENERIC allowlisted query proxy for ordinary dashboard tables, and
//   • DEDICATED hardened actions for the sensitive surface (settings that
//     aren't passwords, and admin_accounts management with hashed passwords).
//
// Password change / reset is handled separately in get-client.js (email-gated,
// works even when locked out). Report-PDF storage upload is hardened later in
// Step 5; the storage bucket policies are untouched by this file.
//
// POST /api/coach-data  { session, op?, table?, ... , action? }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY || '';
const AI_STUDIO_MODEL      = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'; // full Sonnet for long transcripts
const PORTAL_BASE          = process.env.PORTAL_BASE_URL || 'https://portal.gpsleadership.org';
const RESEND_API_KEY       = process.env.RESEND_API_KEY || '';
const RESEND_FROM          = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';

// Business days elapsed since an ISO timestamp (skips Sat/Sun; holidays not
// handled yet). Used to flag coach replies that are past the one-business-day
// promise. Shared idea reused by the nurture feature later.
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

// ── Coach session verification (same HMAC scheme as get-client.js) ──────────
function verifyCoachSession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (!payload || payload.role !== 'coach' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Tables the dashboard may read through the generic proxy.
const READ_TABLES = new Set([
  'clients', 'checkins', 'sprints', 'sprint_closeouts', 'self_checks',
  'diagnostics', 'diagnostic_raters', 'diagnostic_responses',
  'diagnostic_report_drafts', 'diagnostic_question_overrides', 'diagnostic_team_reports',
  'stakeholders', 'survey_responses', 'survey_tokens', 'survey_schedules',
  'ask_alex_usage', 'ask_alex_log', 'email_log', 'email_drafts', 'email_templates', 'email_cc_settings', 'client_errors',
  'testimonials', 'referrals',
  // Decision Room (v27)
  'teams', 'team_members', 'sponsors', 'sponsor_teams', 'recommendations', 'external_signals', 'external_feedback_invites',
  // Workshop Module (v35)
  'workshops', 'workshop_participants', 'workshop_questions', 'workshop_responses',
  // Organizations (v40)
  'organizations',
  // Renewal / payment (v74)
  'renewal_config', 'renewals',
  // AI Studio prompt library (v76)
  'coach_prompts',
]);
// Tables the dashboard may write through the generic proxy.
const WRITE_TABLES = new Set([
  'clients', 'checkins', 'sprints', 'sprint_closeouts',
  'diagnostics', 'diagnostic_raters', 'diagnostic_responses',
  'diagnostic_report_drafts', 'diagnostic_question_overrides', 'diagnostic_team_reports',
  'stakeholders', 'survey_responses', 'testimonials', 'referrals', 'email_cc_settings',
  // Decision Room (v27) — coach CRUD for teams, membership, recs, signals, sponsors
  'teams', 'team_members', 'sponsors', 'sponsor_teams', 'recommendations', 'external_signals',
  // Workshop Module (v35) — coach CRUD for workshops, participants, questions, responses
  'workshops', 'workshop_participants', 'workshop_questions', 'workshop_responses',
  // Organizations (v40)
  'organizations',
  // Renewal / payment (v74) — owner-only write (payment links live here)
  'renewal_config',
  // AI Studio prompt library (v76) — owner-only write
  'coach_prompts',
]);
// NOTE: admin_accounts and coach_settings are intentionally NOT in either set —
// they are served only by the dedicated, hardened actions below.

// Build a PostgREST query string from a structured, safe filter spec.
function buildQuery({ eq = {}, neq = {}, in: inF = {}, is = {}, gte = {}, lte = {}, ilike = {}, order, limit, select }) {
  const parts = [];
  for (const [c, v] of Object.entries(eq))   parts.push(`${encodeURIComponent(c)}=eq.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(neq))  parts.push(`${encodeURIComponent(c)}=neq.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(gte))  parts.push(`${encodeURIComponent(c)}=gte.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(lte))  parts.push(`${encodeURIComponent(c)}=lte.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(ilike))parts.push(`${encodeURIComponent(c)}=ilike.${encodeURIComponent(v)}`);
  for (const [c, v] of Object.entries(is))   parts.push(`${encodeURIComponent(c)}=is.${encodeURIComponent(v === null ? 'null' : v)}`);
  for (const [c, arr] of Object.entries(inF)) {
    const list = (Array.isArray(arr) ? arr : [arr]).map(x => encodeURIComponent(x)).join(',');
    parts.push(`${encodeURIComponent(c)}=in.(${list})`);
  }
  if (select) parts.push(`select=${encodeURIComponent(select)}`);
  if (order && order.col) parts.push(`order=${encodeURIComponent(order.col)}.${order.asc === false ? 'desc' : 'asc'}`);
  if (limit)  parts.push(`limit=${parseInt(limit, 10)}`);
  return parts.join('&');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body = req.body || {};

  // ── Gate: every coach-data request needs a valid coach session ────────────
  const session = verifyCoachSession(body.session);
  if (!session) return res.status(401).json({ error: 'Coach session invalid or expired' });

  // ── RBAC: owner (Alex) vs assistant (EA). Default owner for legacy sessions
  //    issued before lvl existed; new logins always carry lvl. ──────────────
  const lvl = session.lvl || 'owner';
  const isOwner = lvl === 'owner';
  const ownerOnly = () => res.status(403).json({ error: 'Owner-only action. Ask Alex to make this change.' });
  // Sender identity for message attribution. Legacy sessions (issued before
  // identity stamping) carry no name → default to Alex/owner.
  const senderName  = session.nm || 'Alex Tremble';
  const senderEmail = session.em || 'alex@gpsleadership.org';
  const senderAid   = (session.aid != null) ? session.aid : null;
  const senderFirst = String(senderName).split(' ')[0] || 'GPS Leadership';
  // Global IP / templates / automation: assistants may READ but never WRITE.
  const OWNER_ONLY_WRITE = new Set(['email_templates', 'coach_settings', 'diagnostic_question_overrides', 'workshop_questions', 'renewal_config', 'coach_prompts']);
  // Permanent deletion of core records: owner only (assistants run ops, not nukes).
  const OWNER_ONLY_DELETE = new Set(['clients', 'diagnostics', 'teams', 'workshops', 'diagnostic_team_reports', 'diagnostic_raters', 'diagnostic_responses']);

  try {
    const action = body.action;

    // ── Dedicated: non-password settings ────────────────────────────────────
    if (action === 'get-setting') {
      const key = String(body.key || '');
      if (/password/i.test(key)) return res.status(403).json({ error: 'Forbidden setting' });
      const r = await sb(`/rest/v1/coach_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, value: rows[0] ? rows[0].value : null });
    }
    if (action === 'set-setting') {
      if (!isOwner) return ownerOnly();
      const key = String(body.key || '');
      if (/password/i.test(key)) return res.status(403).json({ error: 'Use password reset for credentials' });
      const r = await sb('/rest/v1/coach_settings?on_conflict=key', 'POST',
        { key, value: body.value, updated_at: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not save setting' });
      return res.status(200).json({ ok: true });
    }

    // ── Dedicated: admin_accounts (passwords always hashed) ─────────────────
    if (action === 'admin-list') {
      // Assistants may view the team list (read-only); only owners can modify it.
      const r = await sb('/rest/v1/admin_accounts?select=id,name,email,role,is_active,created_at&order=created_at.asc');
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, admins: rows, viewerLvl: lvl });  // never returns password
    }
    if (action === 'admin-add') {
      if (!isOwner) return ownerOnly();
      if (!body.name || !body.password) return res.status(400).json({ error: 'name and password required' });
      const role = (body.role === 'owner') ? 'owner' : 'assistant';
      const r = await sb('/rest/v1/admin_accounts', 'POST',
        { name: body.name, email: body.email ? String(body.email).toLowerCase() : null, password: hashPassword(body.password), notes: body.notes || null, role, is_active: true },
        { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add admin', detail: d }); }
      return res.status(200).json({ ok: true });
    }
    if (action === 'admin-update') {
      if (!isOwner) return ownerOnly();
      const patch = {};
      if (body.name  != null) patch.name = body.name;
      if (body.email != null) patch.email = String(body.email).toLowerCase();
      if (body.is_active != null) patch.is_active = !!body.is_active;
      if (body.role != null) patch.role = (body.role === 'owner') ? 'owner' : 'assistant';
      if (body.password) patch.password = hashPassword(body.password);
      const r = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}`, 'PATCH', patch, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not update admin' });
      return res.status(200).json({ ok: true });
    }
    if (action === 'admin-delete') {
      if (!isOwner) return ownerOnly();
      await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true });
    }
    // Owner emails an admin a freshly generated password (owner never sees it).
    if (action === 'admin-send-password') {
      if (!isOwner) return ownerOnly();
      const ar = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(body.id)}&select=id,name,email&limit=1`);
      const rows = ar.ok ? await ar.json() : [];
      const acct = rows[0];
      if (!acct) return res.status(404).json({ error: 'Admin account not found' });
      if (!acct.email) return res.status(400).json({ error: 'This account has no email on file. Add one first.' });
      // Readable but strong: 3 word-like chunks + digits.
      const newPw = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
      const pr = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(acct.id)}`, 'PATCH',
        { password: hashPassword(newPw) }, { Prefer: 'return=minimal' });
      if (!pr.ok) return res.status(500).json({ error: 'Could not set the new password' });
      const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
      const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org'; // verified Resend domain; apex is unverified
      if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured (RESEND_API_KEY missing)' });
      const first = (acct.name || 'there').split(' ')[0];
      const er = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM.includes('<') ? RESEND_FROM : `GPS Leadership <${RESEND_FROM}>`,
          to: [acct.email],
          subject: 'Your GPS Coach Dashboard access',
          html: '<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1a1a1a;">'
            + '<h2 style="color:#004369;">Your dashboard access</h2>'
            + `<p>Hi ${first},</p>`
            + '<p>You have access to the GPS Leadership coach dashboard. Here is your password:</p>'
            + `<p style="font-size:18px;font-weight:700;background:#f4f6f9;border-radius:8px;padding:12px 16px;letter-spacing:1px;">${newPw}</p>`
            + '<p>Log in here: <a href="https://portal.gpsleadership.org/coach">portal.gpsleadership.org/coach</a></p>'
            + '<p style="font-size:13px;color:#555;">Keep this somewhere safe (a password manager is best). If you ever need a new one, Alex can send a fresh password from the dashboard.</p>'
            + '<p style="font-size:13px;color:#555;">— GPS Leadership Solutions</p></div>',
        }),
      });
      if (!er.ok) return res.status(500).json({ error: 'Password was set but the email failed to send. Try again.' });
      return res.status(200).json({ ok: true, sent_to: acct.email });
    }

    // ── Ask Alex Log: what clients are actually asking (read-only) ────────────
    // Surfaces the ask_alex_log data we already capture: recent questions across
    // all clients + simple aggregates. Coaching signal + content fuel.
    if (action === 'ask-alex-log') {
      const lr = await sb('/rest/v1/ask_alex_log?select=client_id,asked_at,question_text,response_text&order=asked_at.desc&limit=60');
      const logs = lr.ok ? await lr.json() : [];
      const cr = await sb('/rest/v1/ask_alex_log?select=client_id,asked_at&order=asked_at.desc&limit=2000');
      const all = cr.ok ? await cr.json() : [];
      const now = Date.now();
      const last30 = all.filter(r => r.asked_at && (now - new Date(r.asked_at).getTime()) <= 30 * 864e5).length;
      const byClient = {};
      all.forEach(r => {
        if (!r.client_id) return;
        byClient[r.client_id] = byClient[r.client_id] || { count: 0, last: null };
        byClient[r.client_id].count++;
        if (!byClient[r.client_id].last || r.asked_at > byClient[r.client_id].last) byClient[r.client_id].last = r.asked_at;
      });
      const ids = [...new Set([...logs.map(l => l.client_id), ...Object.keys(byClient)])].filter(Boolean);
      const cmap = {};
      if (ids.length) {
        const clr = await sb(`/rest/v1/clients?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name,organization`);
        const clients = clr.ok ? await clr.json() : [];
        clients.forEach(c => { cmap[c.id] = c; });
      }
      const recent = logs.map(l => ({
        asked_at:         l.asked_at,
        client_id:        l.client_id,
        client_name:      (cmap[l.client_id] && cmap[l.client_id].name) || '(unknown)',
        organization:     (cmap[l.client_id] && cmap[l.client_id].organization) || '',
        question:         String(l.question_text || '').slice(0, 600),
        response_preview: String(l.response_text || '').replace(/PARAGRAPH_BREAK/g, ' ').slice(0, 280),
      }));
      const topClients = Object.entries(byClient)
        .map(([cid, v]) => ({ client_id: cid, name: (cmap[cid] && cmap[cid].name) || '(unknown)', count: v.count, last_at: v.last }))
        .sort((a, b) => b.count - a.count).slice(0, 8);
      return res.status(200).json({
        ok: true,
        totals: { recent_total: all.length, last_30d: last30, distinct_clients: Object.keys(byClient).length },
        recent, top_clients: topClients,
      });
    }

    // ── Contact Your Coach: inbox list (conversations + needs-reply/overdue) ──
    if (action === 'coach-msg-inbox') {
      const cr = await sb('/rest/v1/coach_conversations?select=id,client_id,status,last_message_at&order=last_message_at.desc.nullslast');
      const convs = cr.ok ? await cr.json() : [];
      if (!convs.length) return res.status(200).json({ ok: true, conversations: [] });
      const cids = [...new Set(convs.map(c => c.client_id))];
      const clr = await sb(`/rest/v1/clients?id=in.(${cids.map(encodeURIComponent).join(',')})&select=id,name,email,organization`);
      const clients = clr.ok ? await clr.json() : [];
      const cmap = {}; clients.forEach(c => { cmap[c.id] = c; });
      const convIds = convs.map(c => c.id);
      const mr = await sb(`/rest/v1/coach_messages?conversation_id=in.(${convIds.map(encodeURIComponent).join(',')})&select=conversation_id,sender_role,sender_name,read_by_coach,message_text,created_at&order=created_at.asc`);
      const msgs = mr.ok ? await mr.json() : [];
      const byConv = {}; msgs.forEach(m => { (byConv[m.conversation_id] = byConv[m.conversation_id] || []).push(m); });
      const conversations = convs.map(c => {
        const list = byConv[c.id] || [];
        const last = list[list.length - 1] || null;
        const unread = list.filter(m => m.sender_role === 'client' && !m.read_by_coach).length;
        const needsReply = !!(last && last.sender_role === 'client');     // waiting on coach
        const overdueDays = (needsReply && last) ? businessDaysSince(last.created_at) : 0;
        const cl = cmap[c.client_id] || {};
        return {
          id: c.id, client_id: c.client_id, client_name: cl.name || '(unknown)',
          organization: cl.organization || '', status: c.status, last_message_at: c.last_message_at,
          last_preview: last ? String(last.message_text || '').slice(0, 140) : '',
          last_sender: last ? last.sender_role : null,
          last_sender_name: (last && last.sender_role === 'coach') ? (last.sender_name || 'Alex') : null,
          unread, needs_reply: needsReply, overdue: needsReply && overdueDays >= 1, overdue_days: overdueDays,
        };
      });
      return res.status(200).json({ ok: true, conversations });
    }

    // ── Contact Your Coach: full thread + mark client messages read ───────────
    if (action === 'coach-msg-thread') {
      const cid = body.conversation_id;
      if (!cid) return res.status(400).json({ error: 'conversation_id required' });
      const mr = await sb(`/rest/v1/coach_messages?conversation_id=eq.${encodeURIComponent(cid)}&select=id,sender_role,sender_name,message_type,message_text,created_at,read_by_coach,read_by_client&order=created_at.asc`);
      const messages = mr.ok ? await mr.json() : [];
      await sb(`/rest/v1/coach_messages?conversation_id=eq.${encodeURIComponent(cid)}&sender_role=eq.client&read_by_coach=eq.false`, 'PATCH', { read_by_coach: true }, { Prefer: 'return=minimal' }).catch(() => {});
      return res.status(200).json({ ok: true, messages });
    }

    // ── Contact Your Coach: AI reply draft for coach ─────────────────────────
    // Fetches the thread + client name, calls Claude Haiku, returns a short
    // draft reply. Fire-and-forget from the browser — empty string on any error.
    if (action === 'coach-msg-draft') {
      const cid = body.conversation_id;
      if (!cid) return res.status(400).json({ error: 'conversation_id required' });
      if (!ANTHROPIC_KEY) return res.status(200).json({ ok: true, draft: '' });

      // Fetch thread (last 20 messages ascending)
      const mr = await sb(`/rest/v1/coach_messages?conversation_id=eq.${encodeURIComponent(cid)}&select=sender_role,sender_name,message_type,message_text,created_at&order=created_at.asc&limit=20`);
      const msgs = mr.ok ? await mr.json() : [];
      if (!Array.isArray(msgs) || msgs.length === 0) return res.status(200).json({ ok: true, draft: '' });
      // Only draft when the last message is from the client
      const lastMsg = msgs[msgs.length - 1];
      if (!lastMsg || lastMsg.sender_role !== 'client') return res.status(200).json({ ok: true, draft: '' });

      // Client context (name + org for the prompt)
      const cr = await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}&select=client_id&limit=1`);
      const convRow = (cr.ok ? await cr.json() : [])[0];
      let clientCtx = '';
      if (convRow && convRow.client_id) {
        const clr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(convRow.client_id)}&select=name,organization&limit=1`);
        const cl = (clr.ok ? await clr.json() : [])[0];
        if (cl) clientCtx = `Client: ${cl.name || 'Unknown'}${cl.organization ? ' at ' + cl.organization : ''}.\n`;
      }

      // Build plain transcript
      const transcript = msgs.map(m => {
        const who = m.sender_role === 'coach' ? (m.sender_name || 'Alex') : 'Client';
        return `${who}: ${m.message_text || ''}`;
      }).join('\n\n');

      let draft = '';
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 250,
            system: `You draft short reply suggestions for Alex Tremble, an executive leadership coach at GPS Leadership Solutions. Alex coaches CEOs of multi-location, operations-heavy companies.\n\nAlex's voice: direct, candid, warm but not effusive. Short sentences. No corporate buzzwords. No "Great question!" No emojis. He gets to the point and gives clients something concrete.\n\nWrite a draft reply in Alex's voice — 2-4 sentences. Address what the client said. Give them something useful. No greeting. No sign-off. Draft only.`,
            messages: [{ role: 'user', content: `${clientCtx}\nConversation:\n${transcript}\n\nDraft a reply from Alex to the client's most recent message.` }],
          }),
        });
        if (aiRes.ok) {
          const aiJson = await aiRes.json();
          draft = ((aiJson.content && aiJson.content[0] && aiJson.content[0].text) || '').trim();
        }
      } catch (_) { /* best-effort — return empty if AI unavailable */ }
      return res.status(200).json({ ok: true, draft });
    }

    // ── Contact Your Coach: coach reply (owner only) ──────────────────────────
    if (action === 'coach-msg-reply') {
      // Any authenticated coach (owner or assistant) may reply; the message is
      // attributed to whoever is signed in.
      const cid  = body.conversation_id;
      const text = (body.message_text || '').toString().trim();
      if (!cid || !text) return res.status(400).json({ error: 'conversation_id and message_text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long (5000 character max).' });
      const cr = await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}&select=id,client_id&limit=1`);
      const conv = (cr.ok ? await cr.json() : [])[0];
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const now = new Date().toISOString();
      const ins = await sb('/rest/v1/coach_messages', 'POST', {
        conversation_id: cid, client_id: conv.client_id, sender_role: 'coach',
        sender_name: senderName, sender_admin_id: senderAid,
        message_type: 'progress_update', message_text: text, read_by_coach: true, read_by_client: false, created_at: now,
      }, { Prefer: 'return=minimal' });
      if (!ins.ok) { const d = await ins.json().catch(() => ({})); return res.status(500).json({ error: 'Could not send reply', detail: d }); }
      const newStatus = ['open', 'waiting_on_client', 'closed'].includes(body.status) ? body.status : 'waiting_on_client';
      await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}`, 'PATCH', { status: newStatus, last_message_at: now, updated_at: now }, { Prefer: 'return=minimal' });
      // Best-effort email to the client (non-blocking).
      try {
        const clr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(conv.client_id)}&select=name,email,token&limit=1`);
        const cl = (clr.ok ? await clr.json() : [])[0];
        if (cl && cl.email && RESEND_API_KEY) {
          const first = (cl.name || 'there').split(' ')[0];
          const url = `${PORTAL_BASE}/client?token=${encodeURIComponent(cl.token || '')}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `${senderName} - GPS Leadership <${RESEND_FROM}>`,
              to: [cl.email],
              reply_to: senderEmail,
              subject: `You have a new message from ${senderFirst}`,
              html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;"><p>Hi ${first},</p><p>You have a new message from ${senderFirst} in your GPS coaching portal.</p><p style="margin:22px 0;"><a href="${url}" style="background:#1A3D6E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;">Open your portal</a></p><p style="font-size:13px;color:#666;">Or copy this link: <a href="${url}" style="color:#1A3D6E;">${url}</a></p><p style="font-size:13px;color:#666;">- GPS Leadership Solutions</p></div>`,
            }),
          }).catch(() => {});
        }
      } catch (_) { /* notification is best-effort */ }
      return res.status(200).json({ ok: true });
    }

    // ── Contact Your Coach: COACH starts a new message to a client (owner only) ──
    // Reply-only left no way to reach out first; this finds-or-creates the client's
    // conversation, posts the coach message (unread by client), badges their portal,
    // and emails them — same delivery as coach-msg-reply.
    if (action === 'coach-msg-start') {
      // Owner or assistant may start a message; attributed to whoever is signed in.
      const targetClient = body.client_id;
      const text = (body.message_text || '').toString().trim();
      if (!targetClient || !text) return res.status(400).json({ error: 'client_id and message_text required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long (5000 character max).' });
      // Only coaching clients have the in-portal messaging channel — guard server-side.
      const cgr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(targetClient)}&select=in_coaching_program,coaching_sessions_enabled,is_active_coaching&limit=1`);
      const cgRow = (cgr.ok ? await cgr.json() : [])[0];
      if (!cgRow) return res.status(404).json({ error: 'Client not found' });
      if (!(cgRow.in_coaching_program || cgRow.coaching_sessions_enabled || cgRow.is_active_coaching)) {
        return res.status(400).json({ error: 'That client is not a coaching client and cannot receive portal messages. Email them directly instead.' });
      }
      const now = new Date().toISOString();
      const cr = await sb(`/rest/v1/coach_conversations?client_id=eq.${encodeURIComponent(targetClient)}&select=id&order=last_message_at.desc.nullslast&limit=1`);
      const convs = cr.ok ? await cr.json() : [];
      let cid = convs[0] && convs[0].id;
      if (cid) {
        await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}`, 'PATCH', { status: 'waiting_on_client', last_message_at: now, updated_at: now }, { Prefer: 'return=minimal' });
      } else {
        const insC = await sb('/rest/v1/coach_conversations', 'POST', { client_id: targetClient, status: 'waiting_on_client', last_message_at: now }, { Prefer: 'return=representation' });
        if (!insC.ok) { const d = await insC.json().catch(() => ({})); return res.status(500).json({ error: 'Could not start conversation', detail: d }); }
        const rows = await insC.json(); cid = (Array.isArray(rows) ? rows[0] : rows).id;
      }
      const insM = await sb('/rest/v1/coach_messages', 'POST', {
        conversation_id: cid, client_id: targetClient, sender_role: 'coach',
        sender_name: senderName, sender_admin_id: senderAid,
        message_type: 'progress_update', message_text: text, read_by_coach: true, read_by_client: false, created_at: now,
      }, { Prefer: 'return=minimal' });
      if (!insM.ok) { const d = await insM.json().catch(() => ({})); return res.status(500).json({ error: 'Could not send message', detail: d }); }
      try {
        const clr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(targetClient)}&select=name,email,token&limit=1`);
        const cl = (clr.ok ? await clr.json() : [])[0];
        if (cl && cl.email && RESEND_API_KEY) {
          const first = (cl.name || 'there').split(' ')[0];
          const url = `${PORTAL_BASE}/client?token=${encodeURIComponent(cl.token || '')}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `${senderName} - GPS Leadership <${RESEND_FROM}>`, to: [cl.email], reply_to: senderEmail,
              subject: `You have a new message from ${senderFirst}`,
              html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;"><p>Hi ${first},</p><p>You have a new message from ${senderFirst} in your GPS coaching portal.</p><p style="margin:22px 0;"><a href="${url}" style="background:#1A3D6E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;">Open your portal</a></p><p style="font-size:13px;color:#666;">Or copy this link: <a href="${url}" style="color:#1A3D6E;">${url}</a></p><p style="font-size:13px;color:#666;">- GPS Leadership Solutions</p></div>`,
            }),
          }).catch(() => {});
        }
      } catch (_) { /* email is best-effort */ }
      return res.status(200).json({ ok: true, conversation_id: cid });
    }

    // ── Coaching: check-in staleness — clients who haven't checked in recently ─
    // Returns coaching clients where last check-in is > threshold days ago (or
    // never). Threshold defaults to 14 days. Used by Today tab flag cards.
    if (action === 'coach-checkin-stale') {
      const threshold = parseInt(body.days || 14, 10);
      // All active coaching clients
      const clr = await sb(`/rest/v1/clients?select=id,name,organization&is_archived=eq.false&or=(in_coaching_program.eq.true,coaching_sessions_enabled.eq.true,is_active_coaching.eq.true)&order=name.asc`);
      const clients = clr.ok ? await clr.json() : [];
      if (!Array.isArray(clients) || clients.length === 0) return res.status(200).json({ ok: true, stale: [] });
      const clientIds = clients.map(c => c.id);
      // Fetch recent check-ins for those clients (bulk — last 1000, desc)
      const chr = await sb(`/rest/v1/checkins?client_id=in.(${clientIds.join(',')})&select=client_id,created_at&order=created_at.desc&limit=1000`);
      const checkins = chr.ok ? await chr.json() : [];
      // Last check-in per client
      const lastCheckin = {};
      for (const ch of (Array.isArray(checkins) ? checkins : [])) {
        if (!lastCheckin[ch.client_id]) lastCheckin[ch.client_id] = ch.created_at;
      }
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - threshold);
      const stale = clients
        .filter(c => { const last = lastCheckin[c.id]; return !last || new Date(last) < cutoff; })
        .map(c => {
          const last = lastCheckin[c.id];
          const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
          return { id: c.id, name: c.name, organization: c.organization || '', days_since: days };
        });
      return res.status(200).json({ ok: true, stale });
    }

    // ── Contact Your Coach: change conversation status (owner only) ───────────
    if (action === 'coach-msg-status') {
      if (!isOwner) return ownerOnly();
      const cid = body.conversation_id, st = body.status;
      if (!cid || !['open', 'waiting_on_client', 'closed'].includes(st)) return res.status(400).json({ error: 'valid conversation_id and status required' });
      await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}`, 'PATCH', { status: st, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true });
    }

    // ── Reset plan sponsor review (owner only) ───────────────────────────────
    // Clears plan_sponsor_status so the sponsor can re-review after Alex edits
    // the 90-day plan in response to a changes_requested decision.
    if (action === 'resetPlanReview') {
      if (!isOwner) return ownerOnly();
      const did = body.diagnostic_id;
      if (!did) return res.status(400).json({ error: 'diagnostic_id required' });
      const r = await sb(
        `/rest/v1/diagnostics?id=eq.${encodeURIComponent(did)}`,
        'PATCH',
        { plan_sponsor_status: 'none', plan_sponsor_note: null, plan_sponsor_decided_at: null },
        { Prefer: 'return=minimal' }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Reset failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    // ── Reset plan wizard (owner only) ──────────────────────────────────────────
    // Clears plan_submitted_at + plan_start_date on the linked client so they see
    // the 90-day plan wizard from step 1 again. Used when coach accidentally went
    // through the wizard on a client's behalf, or the client needs a fresh start.
    if (action === 'resetPlanWizard') {
      if (!isOwner) return ownerOnly();
      const did = body.diagnostic_id;
      if (!did) return res.status(400).json({ error: 'diagnostic_id required' });
      const dr = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(did)}&select=client_id`);
      if (!dr.ok) return res.status(500).json({ error: 'Diagnostic lookup failed' });
      const diagRows = await dr.json();
      const clientId = diagRows[0]?.client_id;
      if (!clientId) return res.status(400).json({ error: 'Diagnostic has no linked client' });
      const r = await sb(
        `/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`,
        'PATCH',
        { plan_submitted_at: null, plan_start_date: null, continuation_step: 0 },
        { Prefer: 'return=minimal' }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Reset failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    // ── AI Studio: run a saved prompt against pasted input ───────────────────
    // Fetches the prompt from coach_prompts, prepends the stored system prompt,
    // sends the user's raw input (transcript, notes, etc.) to Claude, and returns
    // the text response. This never streams — transcripts are large but output is
    // bounded, so synchronous response is fine for Vercel's 30s limit.
    if (action === 'run-prompt') {
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      const promptId  = body.prompt_id;
      const userInput = String(body.user_input || '').trim();
      if (!promptId)   return res.status(400).json({ error: 'prompt_id required' });
      if (!userInput)  return res.status(400).json({ error: 'user_input required' });

      // Fetch the stored prompt (including examples, context flags, and token limit)
      const pr = await sb(`/rest/v1/coach_prompts?id=eq.${encodeURIComponent(promptId)}&is_active=eq.true&select=name,prompt_text,output_format,save_target,examples_json,auto_inject_context,max_output_tokens&limit=1`);
      if (!pr.ok) return res.status(500).json({ error: 'Failed to fetch prompt' });
      const prompts = await pr.json();
      if (!prompts || !prompts[0]) return res.status(404).json({ error: 'Prompt not found' });
      const prompt = prompts[0];

      // ── Auto-inject client context ───────────────────────────────────────────
      // When a prompt has auto_inject_context=true AND a diagnostic_id is provided,
      // fetch the leader's profile data from the portal and prepend it to the input
      // so the coach only needs to paste quantitative scores and qualitative comments.
      let effectiveInput = userInput;
      const diagId = body.diagnostic_id ? String(body.diagnostic_id).trim() : null;
      if (prompt.auto_inject_context && diagId) {
        const dr = await sb(
          `/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagId)}&select=client_name,client_title,client_org,kickoff_brief_json,kickoff_brief_saved_at,interview_summaries_json&limit=1`
        );
        if (dr.ok) {
          const dRows = await dr.json();
          const d = dRows && dRows[0];
          if (d) {
            const lines = [
              '━━━ AUTO-INJECTED LEADER PROFILE — GPS Leadership Portal ━━━',
              d.client_name  ? `Leader Name : ${d.client_name}`  : 'Leader Name : [CLIENT NAME]',
              d.client_title ? `Title       : ${d.client_title}` : 'Title       : [TITLE]',
              d.client_org   ? `Organization: ${d.client_org}`   : 'Organization: [ORGANIZATION]',
            ];

            // Kickoff brief (structured JSON from the portal intake call)
            if (d.kickoff_brief_json) {
              lines.push('');
              lines.push(`KICKOFF BRIEF (captured ${d.kickoff_brief_saved_at ? new Date(d.kickoff_brief_saved_at).toLocaleDateString() : 'date unknown'}):`);
              try {
                const kb = typeof d.kickoff_brief_json === 'string'
                  ? JSON.parse(d.kickoff_brief_json)
                  : d.kickoff_brief_json;
                lines.push(JSON.stringify(kb, null, 2));
              } catch (_) {
                lines.push(String(d.kickoff_brief_json));
              }
            } else {
              lines.push('');
              lines.push('KICKOFF BRIEF: [Not yet captured in portal]');
            }

            // Interview summaries (array of structured JSON objects)
            const summaries = Array.isArray(d.interview_summaries_json) ? d.interview_summaries_json : [];
            if (summaries.length > 0) {
              lines.push('');
              lines.push(`INTERVIEW SUMMARIES (${summaries.length} captured):`);
              summaries.forEach((s, i) => {
                lines.push(`\n--- Interview ${i + 1} ---`);
                try {
                  const obj = typeof s === 'string' ? JSON.parse(s) : s;
                  lines.push(JSON.stringify(obj, null, 2));
                } catch (_) {
                  lines.push(String(s));
                }
              });
            } else {
              lines.push('');
              lines.push('INTERVIEW SUMMARIES: [None captured yet]');
            }

            lines.push('━━━ END AUTO-INJECTED CONTEXT ━━━');
            lines.push('');
            lines.push('--- YOUR PASTED INPUT BELOW ---');
            effectiveInput = lines.join('\n') + '\n' + userInput;
          }
        }
        // If context fetch fails, fall through silently and use original userInput
      }

      // Build messages array — prepend few-shot examples if the prompt has any.
      // Examples are {input, output} pairs stored in examples_json; they're sent as
      // alternating user/assistant turns so Claude calibrates its output format
      // against real examples before seeing the actual transcript/input.
      const examples = Array.isArray(prompt.examples_json) ? prompt.examples_json : [];
      const messages = [
        ...examples.flatMap(ex => [
          { role: 'user',      content: String(ex.input  || '') },
          { role: 'assistant', content: String(ex.output || '') },
        ]),
        { role: 'user', content: effectiveInput },
      ];

      const maxTokens = (prompt.max_output_tokens && prompt.max_output_tokens > 0)
        ? prompt.max_output_tokens
        : 4096;

      // Call Claude with the stored system prompt + (optional examples +) user input
      const claude = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: AI_STUDIO_MODEL,
          max_tokens: maxTokens,
          system: prompt.prompt_text,
          messages,
        }),
      });
      if (!claude.ok) {
        const cd = await claude.json().catch(() => ({}));
        return res.status(502).json({ error: 'Claude API error', detail: cd });
      }
      const claudeData = await claude.json();
      const outputText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
      return res.status(200).json({
        ok:                   true,
        output:               outputText,
        output_format:        prompt.output_format,
        save_target:          prompt.save_target,
        prompt_name:          prompt.name,
        auto_inject_context:  !!prompt.auto_inject_context,
        context_injected:     !!(prompt.auto_inject_context && diagId),
        usage:                claudeData.usage || null,
      });
    }

    // ── AI Studio: append one interview summary to diagnostics.interview_summaries_json ──
    // Each call appends a new INTERVIEW_SUMMARY object to the array — does NOT overwrite.
    // Transcripts are never stored; only the structured JSON summary lands here.
    if (action === 'save-interview-summary') {
      if (!isOwner) return ownerOnly();
      const diagId    = body.diagnostic_id;
      const briefStr  = String(body.brief_json || '').trim();
      if (!diagId)    return res.status(400).json({ error: 'diagnostic_id required' });
      if (!briefStr)  return res.status(400).json({ error: 'brief_json required' });

      let parsed;
      try { parsed = JSON.parse(briefStr); }
      catch (_) { return res.status(400).json({ error: 'brief_json is not valid JSON — copy the full output from AI Studio' }); }

      // Fetch the current array, append the new summary, then write back.
      const cur = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagId)}&select=interview_summaries_json&limit=1`);
      if (!cur.ok) return res.status(500).json({ error: 'Failed to read diagnostic' });
      const curData = await cur.json();
      const existing = (curData && curData[0] && Array.isArray(curData[0].interview_summaries_json))
        ? curData[0].interview_summaries_json
        : [];
      existing.push(parsed);

      const r = await sb(
        `/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagId)}`,
        'PATCH',
        { interview_summaries_json: existing },
        { Prefer: 'return=minimal' }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Save failed', detail: d }); }
      return res.status(200).json({ ok: true, total: existing.length });
    }

    // ── AI Studio: save kickoff brief JSON to a diagnostic ───────────────────
    // Stores the KICKOFF_LEADER_BRIEF JSON produced by run-prompt into
    // diagnostics.kickoff_brief_json. Validates JSON before saving so bad output
    // from a truncated response doesn't corrupt the row.
    if (action === 'save-kickoff-brief') {
      if (!isOwner) return ownerOnly();
      const diagId    = body.diagnostic_id;
      const briefStr  = String(body.brief_json || '').trim();
      if (!diagId)    return res.status(400).json({ error: 'diagnostic_id required' });
      if (!briefStr)  return res.status(400).json({ error: 'brief_json required' });

      let parsed;
      try { parsed = JSON.parse(briefStr); }
      catch (_) { return res.status(400).json({ error: 'brief_json is not valid JSON — copy the full output from AI Studio' }); }

      const r = await sb(
        `/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagId)}`,
        'PATCH',
        { kickoff_brief_json: parsed, kickoff_brief_saved_at: new Date().toISOString() },
        { Prefer: 'return=minimal' }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Save failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    // ── Generic allowlisted query proxy ─────────────────────────────────────
    const op    = body.op;
    const table = body.table;
    if (!op || !table) return res.status(400).json({ error: 'Missing op/table or unknown action' });

    if (op === 'select') {
      if (!READ_TABLES.has(table)) return res.status(403).json({ error: `Read not allowed: ${table}` });
      const qs = buildQuery(body);
      const r = await sb(`/rest/v1/${table}?${qs}`);
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Query failed', detail: d }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, rows, row: body.single ? (rows[0] || null) : undefined });
    }

    if (op === 'insert' || op === 'upsert') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && OWNER_ONLY_WRITE.has(table)) return ownerOnly();
      const path = op === 'upsert' && body.onConflict
        ? `/rest/v1/${table}?on_conflict=${encodeURIComponent(body.onConflict)}`
        : `/rest/v1/${table}`;
      const prefer = op === 'upsert' ? 'resolution=merge-duplicates,return=representation' : 'return=representation';
      const r = await sb(path, 'POST', body.values, { Prefer: prefer });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Write failed', detail: d }); }
      const rows = await r.json().catch(() => []);
      return res.status(200).json({ ok: true, rows });
    }

    if (op === 'update') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && OWNER_ONLY_WRITE.has(table)) return ownerOnly();
      // Assistants cannot unlock/edit auto-locked 90-day plans.
      if (!isOwner && (table === 'diagnostics' || table === 'clients') && body.values && /plan_status|plan_locked_at|plan_lock_source/.test(Object.keys(body.values).join(','))) return ownerOnly();
      const qs = buildQuery(body);
      if (!qs) return res.status(400).json({ error: 'Refusing unfiltered update' }); // never PATCH all rows
      const r = await sb(`/rest/v1/${table}?${qs}`, 'PATCH', body.values, { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Update failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    if (op === 'delete') {
      if (!WRITE_TABLES.has(table)) return res.status(403).json({ error: `Write not allowed: ${table}` });
      if (!isOwner && (OWNER_ONLY_DELETE.has(table) || OWNER_ONLY_WRITE.has(table))) return ownerOnly();
      const qs = buildQuery(body);
      if (!qs) return res.status(400).json({ error: 'Refusing unfiltered delete' }); // never DELETE all rows
      const r = await sb(`/rest/v1/${table}?${qs}`, 'DELETE', null, { Prefer: 'return=minimal' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Delete failed', detail: d }); }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown op: ' + op });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
