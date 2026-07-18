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

// ── Message attachments (private bucket + signed links) ───────────────────────
const MSG_ATT_ALLOWED = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-(excel|powerpoint)|image\/(png|jpe?g|webp|gif)|text\/(plain|csv))$/;
async function uploadMsgAttachment(convId, att) {
  if (!att || !att.data) return null;
  const m = String(att.data).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return { error: 'Unsupported file.' };
  const mime = m[1];
  if (!MSG_ATT_ALLOWED.test(mime)) return { error: 'File type not allowed. Use PDF, Word, Excel, PowerPoint, an image, or a text file.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return { error: 'File is over 10 MB — please send a smaller one.' };
  const safe = String(att.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const path = `${convId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/message-attachments/${encodeURI(path)}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buf,
  });
  if (!up.ok) return { error: 'Attachment upload failed.' };
  return { path, name: safe, size: buf.length, type: mime };
}
async function signMsgAttachment(path) {
  if (!path) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/message-attachments/${encodeURI(path)}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
  } catch (_) { return null; }
}
// Upload up to 5 files for one message. Returns { uploaded:[...] } or { error }.
async function uploadMsgAttachments(convId, arr) {
  const list = Array.isArray(arr) ? arr.filter(a => a && a.data).slice(0, 5) : [];
  const out = [];
  for (const att of list) {
    const r = await uploadMsgAttachment(convId, att);
    if (r && r.error) return { error: r.error };
    if (r) out.push(r);
  }
  return { uploaded: out };
}
async function fetchMsgAttachments(messageIds) {
  const ids = (messageIds || []).filter(Boolean);
  if (!ids.length) return {};
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/message_attachments?message_id=in.(${ids.map(encodeURIComponent).join(',')})&select=message_id,path,name,size,type&order=created_at.asc`, {
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` },
    });
    if (!r.ok) return {};
    const rows = await r.json();
    const byMsg = {};
    for (const a of rows) { (byMsg[a.message_id] = byMsg[a.message_id] || []).push(a); }
    return byMsg;
  } catch (_) { return {}; }
}
async function insertMsgAttachments(messageId, uploaded) {
  if (!messageId || !uploaded || !uploaded.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/message_attachments`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(uploaded.map(a => ({ message_id: messageId, path: a.path, name: a.name, size: a.size, type: a.type }))),
    });
  } catch (_) { /* best-effort; the message itself already sent */ }
}
// Attach signed download URLs. Sets msg.attachments = [{name,size,type,download}] from
// the child table when present, else from the legacy single-attachment columns. Keeps
// msg.attachment_download populated for any older client still reading it.
async function withSignedAttachments(messages) {
  const byMsg = await fetchMsgAttachments(messages.map(m => m && m.id));
  for (const msg of messages) {
    if (!msg) continue;
    const child = byMsg[msg.id] || [];
    const atts = [];
    if (child.length) {
      for (const a of child) atts.push({ name: a.name, size: a.size, type: a.type, download: await signMsgAttachment(a.path) });
    } else if (msg.attachment_url) {
      atts.push({ name: msg.attachment_name, size: msg.attachment_size, type: msg.attachment_type, download: await signMsgAttachment(msg.attachment_url) });
    }
    msg.attachments = atts;
    msg.attachment_download = (atts[0] && atts[0].download) || null;
  }
  return messages;
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

  // ── Message channels: 'coach' (Alex's confidential 1:1) vs 'admin' (coordinator/EA).
  //   READ:  owner sees both; assistant sees 'admin' only, unless their account has
  //          can_read_coach_messages = true (owner grants this in Admin Accounts).
  //   WRITE: owner may post to either; assistant posts to 'admin' only — even a
  //          read-permitted assistant never posts AS the coach.
  //   START: owner's new messages open the 'coach' channel; assistant's open 'admin'.
  let _asstCanReadCoach = null;
  async function asstCanReadCoach() {
    if (isOwner) return true;
    if (_asstCanReadCoach !== null) return _asstCanReadCoach;
    _asstCanReadCoach = false;
    if (senderAid != null) {
      try {
        const r = await sb(`/rest/v1/admin_accounts?id=eq.${encodeURIComponent(senderAid)}&select=can_read_coach_messages&limit=1`);
        const row = (r.ok ? await r.json() : [])[0];
        _asstCanReadCoach = !!(row && row.can_read_coach_messages);
      } catch (_) { _asstCanReadCoach = false; }
    }
    return _asstCanReadCoach;
  }
  async function readableChannels() { return (isOwner || await asstCanReadCoach()) ? ['coach', 'admin'] : ['admin']; }
  const writableChannels = () => isOwner ? ['coach', 'admin'] : ['admin'];
  const startChannel = () => isOwner ? 'coach' : 'admin';

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

    // ── Leader profile photo (coach uploads on the leader's behalf) ─────────
    // Same bucket/field the leader's own uploader uses (org-assets ·
    // client-avatars/<id> · clients.avatar_url), so a coach-set photo shows up
    // wherever the leader's own would — before they ever log in. Cache-busted so a
    // replacement shows immediately (same lesson as the report PDF). Any coach session.
    if (action === 'coach-set-avatar') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      const m = String(body.image_data_url || '').match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Use a PNG, JPG, or WebP image.' });
      const mime = m[1];
      const ext  = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const buf  = Buffer.from(m[3], 'base64');
      if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Image is over 6 MB — please use a smaller one.' });
      const path = `client-avatars/${clientId}.${ext}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/org-assets/${path}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': mime, 'x-upsert': 'true' },
        body: buf,
      });
      if (!up.ok) return res.status(502).json({ error: 'Photo upload failed.' });
      const url = `${SUPABASE_URL}/storage/v1/object/public/org-assets/${path}?v=${Date.now()}`;
      const pr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH', { avatar_url: url }, { Prefer: 'return=minimal' });
      if (!pr.ok) return res.status(500).json({ error: 'Uploaded, but could not save it to the profile.' });
      return res.status(200).json({ ok: true, avatar_url: url });
    }
    if (action === 'coach-remove-avatar') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      const pr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH', { avatar_url: null }, { Prefer: 'return=minimal' });
      if (!pr.ok) return res.status(500).json({ error: 'Could not remove the photo.' });
      return res.status(200).json({ ok: true });
    }

    // ── 90-day stakeholder target: approve + lock (Phase 3) ─────────────────
    // The coach owns this number (the leader must not set the bar their own raters
    // judge them against). Locking stamps who/when — the audit trail that makes
    // delegating an engagement to a sub-coach trustworthy. Any valid coach may set it.
    if (action === 'set-pulse-target') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      if (body.clear === true) {
        const pr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH',
          { pulse_target_90: null, pulse_target_90_locked_at: null, pulse_target_90_locked_by: null },
          { Prefer: 'return=minimal' });
        if (!pr.ok) return res.status(500).json({ error: 'Could not clear the target.' });
        return res.status(200).json({ ok: true, cleared: true });
      }
      const t = Number(body.target);
      if (!Number.isFinite(t) || t < 1 || t > 5) return res.status(400).json({ error: 'Target must be a number between 1.0 and 5.0.' });
      const rounded = Math.round(t * 100) / 100;
      const nowIso = new Date().toISOString();
      const pr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH',
        { pulse_target_90: rounded, pulse_target_90_locked_at: nowIso, pulse_target_90_locked_by: senderName },
        { Prefer: 'return=minimal' });
      if (!pr.ok) return res.status(500).json({ error: 'Could not save the target.' });
      return res.status(200).json({ ok: true, target: rounded, locked_by: senderName, locked_at: nowIso });
    }

    // ── AI feature flags (the kill-switch) — owner reads/toggles ─────────────
    if (action === 'ai-flags-list') {
      const r = await sb('/rest/v1/ai_feature_flags?select=feature,enabled,label&order=feature.asc');
      const flags = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, flags });
    }
    if (action === 'ai-flag-set') {
      if (!isOwner) return res.status(403).json({ error: 'Only an owner can change AI settings.' });
      const feature = String(body.feature || '');
      if (!feature) return res.status(400).json({ error: 'feature required' });
      const enabled = !!body.enabled;
      const up = await sb('/rest/v1/ai_feature_flags', 'POST',
        { feature, enabled, updated_at: new Date().toISOString() },
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      if (!up.ok) return res.status(500).json({ error: 'Could not update the AI setting.' });
      return res.status(200).json({ ok: true, feature, enabled });
    }

    // ── AI coaching talking-track draft (Phase 5 pt.2), gated by the flag ────
    // If the feature is OFF (or no API key), return the analog fallback — the coach
    // just uses the deterministic Coaching Moment brief. Never a hard error.
    if (action === 'coaching-brief-draft') {
      const fr = await sb('/rest/v1/ai_feature_flags?feature=eq.coaching_brief&select=enabled&limit=1');
      const frow = fr.ok ? (await fr.json())[0] : null;
      const aiOn = (!frow || frow.enabled !== false) && !!process.env.ANTHROPIC_API_KEY;
      if (!aiOn) return res.status(200).json({ ok: true, ai_disabled: true, draft: null });

      const f = body.facts || {};
      const name     = String(f.name || 'the leader').slice(0, 80);
      const behavior = String(f.behavior || '').slice(0, 400);
      const ffList   = Array.isArray(f.feedforward) ? f.feedforward.slice(0, 8).map(s => String(s).slice(0, 400)) : [];
      const factsText = [
        `Leader: ${name}.`,
        behavior ? `Focus behavior: ${behavior}.` : '',
        (f.baseline != null && f.latest != null) ? `Stakeholder pulse moved from ${f.baseline} (baseline) to ${f.latest} at ${f.latest_label || 'the latest pulse'}.` : (f.baseline != null ? `Baseline stakeholder pulse average: ${f.baseline}.` : ''),
        (f.target != null) ? `90-day stakeholder target: ${f.target}.` : 'No 90-day target set yet.',
        (f.day90_avg != null) ? `Day-90 stakeholder average: ${f.day90_avg} (${f.day90_n || 0} raters).` : '',
        ffList.length ? `Feedforward suggestions from stakeholders:\n- ${ffList.join('\n- ')}` : 'No feedforward suggestions yet.'
      ].filter(Boolean).join('\n');

      const sys = `You are drafting PRIVATE talking points for an executive coach (GPS Leadership Solutions) preparing to debrief a leader. Use Marshall Goldsmith's stakeholder-centered, Feedforward approach: focus forward, be specific and practical, no fluff. Write 3-5 short talking points the coach can use: (1) acknowledge the stakeholder movement honestly, (2) pick ONE or two feedforward items worth focusing on, (3) name any gap between effort and how stakeholders rate them, (4) prompt the leader to follow up DIRECTLY with those stakeholders — that follow-up is what moves the score. Rules: use ONLY the facts given, never invent data or numbers; if a suggestion names another person, describe the behavior without repeating that name; under 180 words; plain text, short lines, no headers.`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 700, system: sys, messages: [{ role: 'user', content: 'Facts:\n' + factsText }] })
      });
      if (!resp.ok) { const t = await resp.text().catch(() => ''); return res.status(502).json({ error: 'AI draft failed', detail: t.slice(0, 200) }); }
      const data = await resp.json();
      const draft = (data && data.content && data.content[0] && data.content[0].text) ? data.content[0].text.trim() : '';
      return res.status(200).json({ ok: true, draft });
    }

    // ── Sponsor follow-along page controls (roadmap #4, Phase 2) ────────────
    // Coach authors the sponsor page's "From your coach" summary + "How you can
    // help" actions and sets the confidentiality mode. Any valid coach session
    // (owner or assistant) may author these.
    if (action === 'sponsor-get-for-client') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      const sel = 'id,name,email,linked_client_id,sponsor_token,coach_summary,coach_summary_updated_at,sponsor_actions,confidentiality_mode';
      // Sponsors linked directly (single-leader) OR via the join table (multi-leader).
      const dr = await sb(`/rest/v1/sponsors?linked_client_id=eq.${encodeURIComponent(clientId)}&active=eq.true&select=${sel}&order=created_at.asc`);
      const directRows = dr.ok ? await dr.json() : [];
      const jr = await sb(`/rest/v1/sponsor_leaders?client_id=eq.${encodeURIComponent(clientId)}&select=sponsor_id`);
      const joinIds = (jr.ok ? await jr.json() : []).map(x => x.sponsor_id);
      let joinRows = [];
      if (joinIds.length) {
        const js = await sb(`/rest/v1/sponsors?id=in.(${joinIds.map(encodeURIComponent).join(',')})&active=eq.true&select=${sel}`);
        joinRows = js.ok ? await js.json() : [];
      }
      const byId = {};
      directRows.forEach(s => { byId[s.id] = Object.assign({ attached_here: 'primary' }, s); });
      joinRows.forEach(s => { if (!byId[s.id]) byId[s.id] = Object.assign({ attached_here: 'join' }, s); });
      const list = Object.values(byId);
      // How many leaders each sponsor follows (primary link + join rows).
      for (const s of list) {
        const cr = await sb(`/rest/v1/sponsor_leaders?sponsor_id=eq.${encodeURIComponent(s.id)}&select=id`);
        const n = (cr.ok ? await cr.json() : []).length;
        s.leader_count = (s.linked_client_id ? 1 : 0) + n;
      }
      return res.status(200).json({ ok: true, sponsors: list });
    }
    // Attach this leader to an existing sponsor (multi-leader). By sponsor_id or
    // sponsor_email. Creates a sponsor_leaders row; the sponsor's follow-along
    // roster then includes this leader. Idempotent (unique sponsor+client).
    if (action === 'sponsor-attach-leader') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      let sponsorId = String(body.sponsor_id || '');
      if (!sponsorId) {
        const email = String(body.sponsor_email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'sponsor_id or sponsor_email required' });
        const sr = await sb(`/rest/v1/sponsors?email=eq.${encodeURIComponent(email)}&active=eq.true&select=id&limit=1`);
        const s = (sr.ok ? await sr.json() : [])[0];
        if (!s) return res.status(404).json({ error: 'No active sponsor with that email. Create the sponsor first (Add → Sponsor).' });
        sponsorId = s.id;
      }
      const ins = await sb('/rest/v1/sponsor_leaders', 'POST', { sponsor_id: sponsorId, client_id: clientId },
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
      if (!ins.ok) { const d = await ins.json().catch(() => ({})); return res.status(500).json({ error: 'Could not attach leader to sponsor', detail: d }); }
      return res.status(200).json({ ok: true });
    }
    // Detach this leader from a sponsor's join-table roster (does not touch a
    // sponsor's primary linked_client_id).
    if (action === 'sponsor-detach-leader') {
      const clientId = String(body.client_id || '');
      const sponsorId = String(body.sponsor_id || '');
      if (!clientId || !sponsorId) return res.status(400).json({ error: 'sponsor_id and client_id required' });
      const r = await sb(`/rest/v1/sponsor_leaders?sponsor_id=eq.${encodeURIComponent(sponsorId)}&client_id=eq.${encodeURIComponent(clientId)}`, 'DELETE', null, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not detach leader' });
      return res.status(200).json({ ok: true });
    }
    // ── Sponsor authorizations ledger (Phase 3) ─────────────────────────────
    // Every bundled approval writes a sponsor_authorizations row. This lists them,
    // enriched with sponsor / org / leader names, so the coach has one place to see
    // who authorized how many seats, the billing choice, and whether it's been paid.
    if (action === 'authorizations-list') {
      const r = await sb('/rest/v1/sponsor_authorizations?select=id,sponsor_id,team_id,leader_client_ids,seat_count,billing_choice,billing_note,paid_at,paid_by,created_at&order=created_at.desc&limit=200');
      const rows = r.ok ? await r.json() : [];
      const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
      const sponsorIds = uniq(rows.map(x => x.sponsor_id));
      const teamIds = uniq(rows.map(x => x.team_id));
      const clientIds = uniq(rows.reduce((acc, x) => acc.concat(Array.isArray(x.leader_client_ids) ? x.leader_client_ids : []), []));
      const sMap = {}, tMap = {}, cMap = {};
      if (sponsorIds.length) { const sr = await sb(`/rest/v1/sponsors?id=in.(${sponsorIds.map(encodeURIComponent).join(',')})&select=id,name`); (sr.ok ? await sr.json() : []).forEach(s => { sMap[s.id] = s.name; }); }
      if (teamIds.length) { const tr = await sb(`/rest/v1/teams?id=in.(${teamIds.map(encodeURIComponent).join(',')})&select=id,name,client_org_name`); (tr.ok ? await tr.json() : []).forEach(t => { tMap[t.id] = t.client_org_name || t.name; }); }
      if (clientIds.length) { const cr = await sb(`/rest/v1/clients?id=in.(${clientIds.map(encodeURIComponent).join(',')})&select=id,name`); (cr.ok ? await cr.json() : []).forEach(c => { cMap[c.id] = c.name; }); }
      const out = rows.map(x => ({
        id: x.id, seat_count: x.seat_count, billing_choice: x.billing_choice, billing_note: x.billing_note,
        paid_at: x.paid_at, created_at: x.created_at,
        sponsor_name: sMap[x.sponsor_id] || '—',
        org_name: tMap[x.team_id] || '—',
        leader_names: (Array.isArray(x.leader_client_ids) ? x.leader_client_ids : []).map(id => cMap[id] || 'Unknown leader'),
      }));
      return res.status(200).json({ ok: true, authorizations: out });
    }
    if (action === 'authorization-mark-paid') {
      const authId = String(body.auth_id || '');
      if (!authId) return res.status(400).json({ error: 'auth_id required' });
      const paid = body.paid === true;
      const upd = paid ? { paid_at: new Date().toISOString(), paid_by: 'coach' } : { paid_at: null, paid_by: null };
      const r = await sb(`/rest/v1/sponsor_authorizations?id=eq.${encodeURIComponent(authId)}`, 'PATCH', upd, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not update payment status' });
      return res.status(200).json({ ok: true, paid });
    }
    // ── Email send-failure surfacing ────────────────────────────────────────
    // Any email that logged status='error' recently (e.g. a Resend quota 429 that
    // silently dropped invites). Feeds the dashboard alert banner so failed sends
    // are never invisible again.
    if (action === 'email-failures') {
      const hours = Math.min(Math.max(parseInt(body.hours, 10) || 48, 1), 168);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const [er, sr] = await Promise.all([
        sb(`/rest/v1/email_log?status=eq.error&sent_at=gte.${encodeURIComponent(since)}&select=recipient_name,recipient_email,email_type,subject,error_details,sent_at&order=sent_at.desc&limit=300`),
        sb(`/rest/v1/email_log?status=eq.sent&sent_at=gte.${encodeURIComponent(since)}&select=recipient_email,email_type,sent_at&limit=3000`),
      ]);
      const errs = er.ok ? await er.json() : [];
      const sents = sr.ok ? await sr.json() : [];
      // A failure is RESOLVED once the same recipient+type was later sent successfully.
      // Only unresolved failures reach the banner, so it auto-clears after a re-send.
      const sentMax = {};
      for (const s of sents) { const k = (s.recipient_email || '') + '|' + (s.email_type || ''); const t = +new Date(s.sent_at); if (!sentMax[k] || t > sentMax[k]) sentMax[k] = t; }
      const rows = errs.filter(e => { const k = (e.recipient_email || '') + '|' + (e.email_type || ''); return !(sentMax[k] && sentMax[k] > +new Date(e.sent_at)); });
      const quota = rows.filter(x => /quota|429|rate limit/i.test(String(x.error_details || ''))).length;
      return res.status(200).json({
        ok: true, count: rows.length, quota,
        failures: rows.slice(0, 25).map(x => ({
          recipient_name: x.recipient_name, recipient_email: x.recipient_email,
          email_type: x.email_type, subject: x.subject, sent_at: x.sent_at,
          reason: /quota|429|rate limit/i.test(String(x.error_details || '')) ? 'Daily email quota reached' : (String(x.error_details || '').slice(0, 80) || 'Send error'),
        })),
      });
    }
    if (action === 'sponsor-save-content') {
      const sponsorId = String(body.sponsor_id || '');
      if (!sponsorId) return res.status(400).json({ error: 'sponsor_id required' });
      const upd = {};
      if (body.coach_summary !== undefined)  upd.coach_summary  = (body.coach_summary == null)  ? null : String(body.coach_summary).slice(0, 4000);
      if (body.sponsor_actions !== undefined) upd.sponsor_actions = (body.sponsor_actions == null) ? null : String(body.sponsor_actions).slice(0, 2000);
      if (body.confidentiality_mode !== undefined) {
        const m = String(body.confidentiality_mode);
        if (!['summary', 'outcomes_only'].includes(m)) return res.status(400).json({ error: 'invalid confidentiality_mode' });
        upd.confidentiality_mode = m;
      }
      if ('coach_summary' in upd) upd.coach_summary_updated_at = new Date().toISOString();
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'nothing to update' });
      const r = await sb(`/rest/v1/sponsors?id=eq.${encodeURIComponent(sponsorId)}`, 'PATCH', upd, { Prefer: 'return=representation' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not save sponsor content', detail: d }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, sponsor: Array.isArray(rows) ? rows[0] : rows });
    }

    // ── Coach marks a coaching session complete from the Progress tab ────────
    // The coach's click is the lock: it flags the week's check-in row as counted
    // and advances coaching_sessions_completed. Idempotent per WEEK (a week counts
    // once even with multiple rows), reversible (un-mark decrements).
    if (action === 'mark-session-complete') {
      const checkinId = String(body.checkin_id || '');
      const complete  = body.complete === true;
      if (!checkinId) return res.status(400).json({ error: 'checkin_id required' });
      const cr = await sb(`/rest/v1/checkins?id=eq.${encodeURIComponent(checkinId)}&select=id,client_id,week_number,counted_toward_sessions&limit=1`);
      const ck = (cr.ok ? await cr.json() : [])[0];
      if (!ck) return res.status(404).json({ error: 'Check-in not found' });
      const clientId = ck.client_id;

      // Which rows already count this week (for idempotency + reversal).
      const wr = await sb(`/rest/v1/checkins?client_id=eq.${encodeURIComponent(clientId)}&week_number=eq.${encodeURIComponent(ck.week_number)}&counted_toward_sessions=is.true&select=id`);
      const weekCountedRows = wr.ok ? await wr.json() : [];

      const clr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=coaching_sessions_total,coaching_sessions_completed&limit=1`);
      const cli = (clr.ok ? await clr.json() : [])[0] || {};
      const total = cli.coaching_sessions_total;
      let done = cli.coaching_sessions_completed || 0;

      if (complete) {
        if (ck.counted_toward_sessions) return res.status(200).json({ ok: true, completed: done });
        await sb(`/rest/v1/checkins?id=eq.${encodeURIComponent(checkinId)}`, 'PATCH', { counted_toward_sessions: true }, { Prefer: 'return=minimal' });
        if (weekCountedRows.length === 0 && (total == null || done < total)) {
          done = done + 1;
          await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH', { coaching_sessions_completed: done }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, completed: done });
      } else {
        if (!ck.counted_toward_sessions) return res.status(200).json({ ok: true, completed: done });
        await sb(`/rest/v1/checkins?id=eq.${encodeURIComponent(checkinId)}`, 'PATCH', { counted_toward_sessions: false }, { Prefer: 'return=minimal' });
        const otherCounted = weekCountedRows.some(r => r.id !== checkinId);
        if (!otherCounted && done > 0) {
          done = done - 1;
          await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, 'PATCH', { coaching_sessions_completed: done }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, completed: done });
      }
    }

    // ── Recommendation tracking (agreed recommendations per engagement) ─────
    // Coach fully manages recs. Sponsor completes only their OWN (handled in
    // api/sponsor.js); the coach can complete ANY rec — protects the ground truth.
    if (action === 'recs-for-client') {
      const clientId = String(body.client_id || '');
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      const r = await sb(`/rest/v1/recommendations?client_id=eq.${encodeURIComponent(clientId)}&select=id,short_title,description,category,status,owner,responsible_party,timeframe,horizon,coach_comment,completed_at,completed_by,sort_order,created_at&order=sort_order.asc.nullslast,created_at.asc`);
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ ok: true, recommendations: rows });
    }
    if (action === 'rec-save') {
      const rec = body.rec || {};
      const clientId = String(rec.client_id || body.client_id || '');
      const rp = ['sponsor', 'leader', 'coach'].includes(rec.responsible_party) ? rec.responsible_party : 'leader';
      const title = String(rec.short_title || '').trim();
      if (!title) return res.status(400).json({ error: 'A short title is required' });
      if (rec.id) {
        const upd = {
          short_title: title.slice(0, 200),
          description: rec.description != null ? String(rec.description).slice(0, 2000) : null,
          responsible_party: rp,
          timeframe: rec.timeframe != null ? String(rec.timeframe).slice(0, 120) : null,
          category: rec.category != null ? String(rec.category).slice(0, 80) : null,
        };
        const r = await sb(`/rest/v1/recommendations?id=eq.${encodeURIComponent(rec.id)}`, 'PATCH', upd, { Prefer: 'return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not update recommendation', detail: d }); }
        const rows = await r.json();
        return res.status(200).json({ ok: true, recommendation: Array.isArray(rows) ? rows[0] : rows });
      }
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      const payload = {
        client_id: clientId, short_title: title.slice(0, 200),
        description: rec.description != null ? String(rec.description).slice(0, 2000) : null,
        responsible_party: rp,
        timeframe: rec.timeframe != null ? String(rec.timeframe).slice(0, 120) : null,
        category: rec.category != null ? String(rec.category).slice(0, 80) : null,
        status: 'approved', visible_to_client: false,
      };
      const r = await sb('/rest/v1/recommendations', 'POST', payload, { Prefer: 'return=representation' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add recommendation', detail: d }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, recommendation: Array.isArray(rows) ? rows[0] : rows });
    }
    if (action === 'rec-comment') {
      const recId = String(body.rec_id || '');
      if (!recId) return res.status(400).json({ error: 'rec_id required' });
      const comment = body.coach_comment != null ? String(body.coach_comment).slice(0, 2000) : null;
      const r = await sb(`/rest/v1/recommendations?id=eq.${encodeURIComponent(recId)}`, 'PATCH', { coach_comment: comment }, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not save comment' });
      return res.status(200).json({ ok: true });
    }
    if (action === 'rec-complete') {
      // Coach can complete/undo ANY rec (including leader-owned) — the ground truth.
      const recId = String(body.rec_id || '');
      if (!recId) return res.status(400).json({ error: 'rec_id required' });
      const upd = body.completed === true
        ? { completed_at: new Date().toISOString(), completed_by: 'coach' }
        : { completed_at: null, completed_by: null };
      const r = await sb(`/rest/v1/recommendations?id=eq.${encodeURIComponent(recId)}`, 'PATCH', upd, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not update recommendation' });
      return res.status(200).json({ ok: true });
    }
    if (action === 'rec-delete') {
      const recId = String(body.rec_id || '');
      if (!recId) return res.status(400).json({ error: 'rec_id required' });
      const r = await sb(`/rest/v1/recommendations?id=eq.${encodeURIComponent(recId)}`, 'DELETE', null, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not delete recommendation' });
      return res.status(200).json({ ok: true });
    }
    // Set who owns a rec (responsible_party) — the clean enum that gates who may
    // complete it. Recs come from the plan-approval flow with a messy free-text
    // `owner`; the coach assigns the clean owner here. null = coach-only completion.
    if (action === 'rec-set-responsible') {
      const recId = String(body.rec_id || '');
      if (!recId) return res.status(400).json({ error: 'rec_id required' });
      const rp = ['sponsor', 'leader', 'coach'].includes(body.responsible_party) ? body.responsible_party : null;
      const r = await sb(`/rest/v1/recommendations?id=eq.${encodeURIComponent(recId)}`, 'PATCH', { responsible_party: rp }, { Prefer: 'return=minimal' });
      if (!r.ok) return res.status(500).json({ error: 'Could not set who owns this recommendation' });
      return res.status(200).json({ ok: true, responsible_party: rp });
    }

    // ── Dedicated: admin_accounts (passwords always hashed) ─────────────────
    if (action === 'admin-list') {
      // Assistants may view the team list (read-only); only owners can modify it.
      const r = await sb('/rest/v1/admin_accounts?select=id,name,email,role,is_active,can_read_coach_messages,created_at&order=created_at.asc');
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
      if (body.can_read_coach_messages != null) patch.can_read_coach_messages = !!body.can_read_coach_messages;
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
      const _rc = await readableChannels();   // 'coach'/'admin' this session may see
      const cr = await sb(`/rest/v1/coach_conversations?select=id,client_id,status,last_message_at,channel&channel=in.(${_rc.join(',')})&order=last_message_at.desc.nullslast`);
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
          channel: c.channel || 'coach',
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
      // Channel gate: an assistant can't open the coach's confidential thread.
      const _gcr = await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}&select=channel&limit=1`);
      const _gconv = (_gcr.ok ? await _gcr.json() : [])[0];
      const _grc = await readableChannels();
      if (_gconv && !_grc.includes(_gconv.channel || 'coach')) return res.status(403).json({ error: 'You do not have access to this thread.' });
      const mr = await sb(`/rest/v1/coach_messages?conversation_id=eq.${encodeURIComponent(cid)}&select=id,sender_role,sender_name,message_type,message_text,created_at,read_by_coach,read_by_client,attachment_url,attachment_name,attachment_size,attachment_type&order=created_at.asc`);
      const messages = mr.ok ? await withSignedAttachments(await mr.json()) : [];
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

    // ── Ad-hoc SMS to a single client (opt-in required, compliance-gated) ──────
    // Lets a coach text one client a custom message (e.g. "haven't heard from
    // you — let's talk"). Only sends to clients who opted in AND have a number.
    if (action === 'send-client-sms') {
      const clientId = body.client_id;
      const text = (body.message || '').toString().trim();
      if (!clientId || !text) return res.status(400).json({ error: 'client_id and message are required' });
      if (text.length > 640) return res.status(400).json({ error: 'Message is too long (640 character max).' });
      const clr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=id,name,phone,sms_opt_in&limit=1`);
      const cl = (clr.ok ? await clr.json() : [])[0];
      if (!cl) return res.status(404).json({ error: 'Client not found' });
      if (!cl.sms_opt_in) return res.status(400).json({ error: "This client hasn't opted in to text messages. They can turn it on in their profile." });
      if (!cl.phone) return res.status(400).json({ error: 'This client has no mobile number on file.' });
      const { sendSms, smsConfigured } = require('./twilio-sms');
      if (!smsConfigured()) return res.status(503).json({ error: 'Texting is not live yet (Twilio setup / campaign approval pending).' });
      const r = await sendSms({ to: cl.phone, body: text });
      try {
        await sb('/rest/v1/email_log', 'POST', {
          client_id: cl.id, recipient_email: cl.phone, recipient_name: cl.name,
          email_type: 'coach_sms', subject: text.slice(0, 140),
          status: r.ok ? 'sent' : 'error',
          error_details: r.ok ? null : (r.error || r.reason || 'send failed'),
          resend_id: r.sid || null,
        }, { Prefer: 'return=minimal' });
      } catch (_) { /* audit log is best-effort */ }
      if (!r.ok) return res.status(502).json({ error: r.error || r.reason || 'Text failed to send.' });
      return res.status(200).json({ ok: true, to: r.to, sid: r.sid });
    }

    // ── Contact Your Coach: coach reply (owner only) ──────────────────────────
    if (action === 'coach-msg-reply') {
      // Any authenticated coach (owner or assistant) may reply; the message is
      // attributed to whoever is signed in.
      const cid  = body.conversation_id;
      const text = (body.message_text || '').toString().trim();
      const attInput = (Array.isArray(body.attachments) && body.attachments.length) ? body.attachments : (body.attachment ? [body.attachment] : []);
      const hasAtt = attInput.some(a => a && a.data);
      if (!cid || (!text && !hasAtt)) return res.status(400).json({ error: 'conversation_id and a message or file are required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long (5000 character max).' });
      const cr = await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}&select=id,client_id,channel&limit=1`);
      const conv = (cr.ok ? await cr.json() : [])[0];
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      // Channel gate: an assistant may only post in the 'admin' thread, never as the coach.
      if (!writableChannels().includes(conv.channel || 'coach')) return res.status(403).json({ error: 'You cannot reply in this thread.' });
      const now = new Date().toISOString();
      let uploaded = [];
      if (hasAtt) { const u = await uploadMsgAttachments(cid, attInput); if (u.error) return res.status(400).json({ error: u.error }); uploaded = u.uploaded; }
      const ins = await sb('/rest/v1/coach_messages', 'POST', {
        conversation_id: cid, client_id: conv.client_id, sender_role: 'coach',
        sender_name: senderName, sender_admin_id: senderAid,
        message_type: 'progress_update', message_text: text, read_by_coach: true, read_by_client: false, created_at: now,
      }, { Prefer: 'return=representation' });
      if (!ins.ok) { const d = await ins.json().catch(() => ({})); return res.status(500).json({ error: 'Could not send reply', detail: d }); }
      const _rmsg = (await ins.json())[0]; await insertMsgAttachments(_rmsg && _rmsg.id, uploaded);
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
      const attInput = (Array.isArray(body.attachments) && body.attachments.length) ? body.attachments : (body.attachment ? [body.attachment] : []);
      const hasAtt = attInput.some(a => a && a.data);
      if (!targetClient || (!text && !hasAtt)) return res.status(400).json({ error: 'client_id and a message or file are required' });
      if (text.length > 5000) return res.status(400).json({ error: 'Message is too long (5000 character max).' });
      // Only coaching clients have the in-portal messaging channel — guard server-side.
      const cgr = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(targetClient)}&select=in_coaching_program,coaching_sessions_enabled,is_active_coaching&limit=1`);
      const cgRow = (cgr.ok ? await cgr.json() : [])[0];
      if (!cgRow) return res.status(404).json({ error: 'Client not found' });
      if (!(cgRow.in_coaching_program || cgRow.coaching_sessions_enabled || cgRow.is_active_coaching)) {
        return res.status(400).json({ error: 'That client is not a coaching client and cannot receive portal messages. Email them directly instead.' });
      }
      const now = new Date().toISOString();
      // Channel: an explicit body.channel (if the sender may write it) else the sender's
      // own channel (owner→coach, assistant→admin). Assistants can't force the coach channel.
      let _startChan = (body.channel === 'admin' || body.channel === 'coach') ? body.channel : startChannel();
      if (!writableChannels().includes(_startChan)) _startChan = startChannel();
      const cr = await sb(`/rest/v1/coach_conversations?client_id=eq.${encodeURIComponent(targetClient)}&channel=eq.${_startChan}&select=id&limit=1`);
      const convs = cr.ok ? await cr.json() : [];
      let cid = convs[0] && convs[0].id;
      if (cid) {
        await sb(`/rest/v1/coach_conversations?id=eq.${encodeURIComponent(cid)}`, 'PATCH', { status: 'waiting_on_client', last_message_at: now, updated_at: now }, { Prefer: 'return=minimal' });
      } else {
        const insC = await sb('/rest/v1/coach_conversations', 'POST', { client_id: targetClient, channel: _startChan, status: 'waiting_on_client', last_message_at: now }, { Prefer: 'return=representation' });
        if (!insC.ok) { const d = await insC.json().catch(() => ({})); return res.status(500).json({ error: 'Could not start conversation', detail: d }); }
        const rows = await insC.json(); cid = (Array.isArray(rows) ? rows[0] : rows).id;
      }
      let uploadedS = [];
      if (hasAtt) { const u = await uploadMsgAttachments(cid, attInput); if (u.error) return res.status(400).json({ error: u.error }); uploadedS = u.uploaded; }
      const insM = await sb('/rest/v1/coach_messages', 'POST', {
        conversation_id: cid, client_id: targetClient, sender_role: 'coach',
        sender_name: senderName, sender_admin_id: senderAid,
        message_type: 'progress_update', message_text: text, read_by_coach: true, read_by_client: false, created_at: now,
      }, { Prefer: 'return=representation' });
      if (!insM.ok) { const d = await insM.json().catch(() => ({})); return res.status(500).json({ error: 'Could not send message', detail: d }); }
      const _smsg = (await insM.json())[0]; await insertMsgAttachments(_smsg && _smsg.id, uploadedS);
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

      // Strip markdown code fences the model sometimes adds (```json … ```)
      const cleanBrief1 = briefStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      let parsed;
      try { parsed = JSON.parse(cleanBrief1); }
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

      // Strip markdown code fences the model sometimes adds (```json … ```)
      const cleanBrief2 = briefStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      let parsed;
      try { parsed = JSON.parse(cleanBrief2); }
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
