// GPS Leadership — Client Portal Data API (Phase 1 hardening)
// Single token-validated endpoint that replaces all direct anon-key Supabase
// calls in client.html. Every action derives the client from the portal token
// SERVER-SIDE (service role key) and scopes the operation to that client only —
// a caller can never read or write another client's data, and can never set
// privileged fields (token, is_active, in_coaching_program, ai_terms_*, etc.).
//
// POST /api/portal-data  { token, action, ...payload }
//
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY
//
// NOTE: CORS is '*' for now to match the rest of the API; tightened to the
// portal origin in Phase 1 Step 6 alongside the /api/ask + cron changes.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';
const COACH_EMAIL     = 'alex@gpsleadership.org';

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

// Columns a client is allowed to set on their own clients row (plan + profile).
// Anything not in this set is silently dropped — prevents privilege escalation.
const CLIENT_WRITABLE = new Set([
  'tp3_pillar', 'goal_description', 'goal_30_day', 'goal_statement',
  'behavior_1', 'behavior_2', 'start_behavior',
  'metric_1_name', 'metric_1_baseline', 'metric_1_target', 'metric_1_type', 'metric_1_ratio_denom',
  'metric_2_name', 'metric_2_baseline', 'metric_2_target', 'metric_2_question', 'metric_2_target_avg',
  'metric_3_name', 'metric_3_baseline', 'metric_3_target',
  'metric_name', 'metric_baseline', 'metric_target', 'metric_current',
  'plan_start_date', 'reward_30_day', 'reward_90_day', 'timezone',
  'goal_90_day', 'plan_submitted_at',
  'industry', 'revenue_band', 'num_locations', 'regions_owned', 'direct_reports_count',
  'preferred_name',
  // Client-editable profile fields (own profile screen — no role/access escalation).
  // 'organization' is canonical; 'org' kept writable only for backward-compat.
  'title', 'organization', 'org', 'phone', 'sms_opt_in',
  // Contact details the client fills in during onboarding (for mailings/records).
  'date_of_birth', 'mailing_line1', 'mailing_line2', 'mailing_city', 'mailing_state', 'mailing_postal_code',
]);
function pickWritable(updates) {
  const out = {};
  for (const k of Object.keys(updates || {})) if (CLIENT_WRITABLE.has(k)) out[k] = updates[k];
  return out;
}

async function findClientByToken(token) {
  if (!token) return null;
  const r = await sb(`/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&limit=1&select=id,email,name,in_coaching_program,plan_submitted_at,allow_plan_edit,coaching_sessions_enabled,is_active_coaching,first_big_win_flag`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Single source of truth for "is this an active coaching client" — derived from
// the existing booleans (no separate status column that can drift). Mirrors the
// gate in get-client.js. Messaging is available only to coaching clients.
function isCoachingClient(c) {
  return !!(c && (c.in_coaching_program || c.coaching_sessions_enabled || c.is_active_coaching));
}

const COACH_MSG_TYPES = new Set(['quick_question', 'prep_for_session', 'progress_update', 'win', 'logistics', 'reschedule']);

// Confirm a diagnostic belongs to this client before any rater/diagnostic write.
async function diagnosticOwnedBy(diagnosticId, clientId) {
  if (!diagnosticId) return false;
  const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnosticId)}&client_id=eq.${encodeURIComponent(clientId)}&limit=1&select=id`);
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// AI specificity gate for a leader's vision (Project #2, F3). PASS only if it
// describes a future STATE of the team/org/leadership (not a credential/title/task),
// names an observable behavior/outcome, and is more than a bare phrase. Fails OPEN
// (pass:true) on any missing key or API error so a flaky model never traps the leader.
async function visionGate(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { pass: true, nudge: '' };
  const model = process.env.CLAUDE_FAST || 'claude-haiku-4-5-20251001';
  const sys = `You gate a leadership "vision" statement for specificity. PASS only if ALL are true: (a) it describes a future STATE of the person's team, organization, or leadership — NOT a personal credential, title, certification, or a single task; (b) it names at least one OBSERVABLE behavior or outcome (what people would do, see, or experience); (c) it is more than a single noun or bare phrase. FAIL examples: "Get PMP certified", "Become VP", "A great team", "Better communication". Respond with ONLY compact JSON: {"pass": true|false, "nudge": "<one warm, specific coaching sentence telling them exactly what observable part to add — only when pass is false>"}.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 220, system: sys, messages: [{ role: 'user', content: 'Vision to gate:\n"""\n' + text + '\n"""' }] }),
    });
    if (!r.ok) return { pass: true, nudge: '' };
    const j = await r.json();
    const txt = (j.content && j.content[0] && j.content[0].text) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { pass: true, nudge: '' };
    const parsed = JSON.parse(m[0]);
    return { pass: !!parsed.pass, nudge: typeof parsed.nudge === 'string' ? parsed.nudge : '' };
  } catch (_) {
    return { pass: true, nudge: '' };
  }
}

// Milestone + celebration state for the 30- and 90-day goals. Computed here so the
// dates and "on-time vs recovery" call are trustworthy (never client date math).
// Reward-timing rule (locked): a hit ON/BEFORE the target date is on-time; a hit
// AFTER it is recovery (still celebrated); target passed with value < target is a
// miss (day-of reflection only — no false celebration).
function computeMilestoneState(client) {
  const startStr = client.coaching_program_start_date || client.plan_start_date || null;
  const sponsored = client.sponsor_outcome_focus === true;
  const out = { sponsored, preferred_name: client.preferred_name || null, m30: null, m90: null };
  if (!startStr) return out;
  const start = new Date(String(startStr).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(start.getTime())) return out;
  const now = new Date();
  const DAY = 86400000;
  const day_n = Math.max(0, Math.floor((now - start) / DAY));
  const target  = client.metric_target  != null ? Number(client.metric_target)  : null;
  const current = client.metric_current != null ? Number(client.metric_current) : null;
  const todayOnly = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  function phase(days, goalText, celebratedAt) {
    const targetDate = new Date(start.getTime() + days * DAY);
    const hasMetric = (target != null && current != null && !Number.isNaN(target) && !Number.isNaN(current));
    const hit = hasMetric && current >= target;
    const past = now > targetDate;
    const missed = hasMetric && !hit && past;
    const celebrated = !!celebratedAt;
    const variant = hit ? (now <= targetDate ? 'on_time' : 'recovery') : (missed ? 'miss' : null);
    // In-portal reminder window: exact T-5 and day-of (matches the email cadence),
    // only while the goal isn't already hit. Client de-dups per session.
    const daysUntil = Math.round((targetDate - todayOnly) / DAY);
    let reminder_due = null;
    if (!hit) {
      if (daysUntil === 5) reminder_due = 't5';
      else if (daysUntil === 0) reminder_due = 'dayof';
    }
    return {
      target_date: targetDate.toISOString().slice(0, 10),
      day_n,
      days_until: daysUntil,
      goal: goalText || null,
      plan: client.start_behavior || null,
      metric_current: current,
      metric_target: target,
      hit,
      missed,
      celebrated,
      variant,
      should_celebrate: hit && !celebrated,   // client shows the modal once
      reminder_due,
    };
  }
  out.m30 = phase(30, client.goal_30_day, client.celebrated_30_at);
  // 90-day goal: dedicated field, falling back to goal_statement for clients
  // captured before goal_90_day existed (§2.1).
  out.m90 = phase(90, client.goal_90_day || client.goal_statement, client.celebrated_90_at);
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body   = req.body || {};
  const action = body.action;
  const token  = body.token;

  const client = await findClientByToken(token);
  if (!client) return res.status(401).json({ error: 'Invalid or expired portal token' });
  const clientId = client.id;

  try {
    switch (action) {

      // ── Check-in drafts ────────────────────────────────────────────────────
      case 'save-draft': {
        const r = await sb('/rest/v1/checkin_drafts?on_conflict=client_id,week_number', 'POST', {
          client_id: clientId, week_number: body.week_number, data: body.data, saved_at: new Date().toISOString(),
        }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not save draft' });
        return res.status(200).json({ ok: true });
      }
      case 'get-draft': {
        const r = await sb(`/rest/v1/checkin_drafts?client_id=eq.${clientId}&week_number=eq.${encodeURIComponent(body.week_number)}&select=data,saved_at&limit=1`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, draft: rows[0] || null });
      }
      case 'delete-draft': {
        await sb(`/rest/v1/checkin_drafts?client_id=eq.${clientId}&week_number=eq.${encodeURIComponent(body.week_number)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Check-in submission ─────────────────────────────────────────────────
      case 'submit-checkin': {
        const c = body.checkin || {};
        c.client_id = clientId;                 // force ownership; ignore any supplied id
        const r = await sb('/rest/v1/checkins', 'POST', c, { Prefer: 'return=minimal' });
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          return res.status(500).json({ error: 'Error saving check-in', detail });
        }
        if (typeof c.metric_value === 'number' && !Number.isNaN(c.metric_value)) {
          await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { metric_current: c.metric_value }, { Prefer: 'return=minimal' });
        }
        // NOTE: the leader's attended_coaching answer is RECORDED here but does not
        // decrement the session count — under the coach-confirms model the coach locks
        // each completed session on the Progress & Check-ins tab (Phase B). The leader's
        // answer just pre-suggests it there.
        return res.status(200).json({ ok: true });
      }

      // ── Client record (plan + profile, allowlisted) ─────────────────────────
      case 'update-client': {
        const updates = pickWritable(body.updates);
        // The 90-day goal is locked once the plan is submitted (unless the coach
        // re-opened editing). After that, the leader changes it only via
        // "Request a change" — never by a direct write (Project #2, F4).
        if (updates.goal_statement != null && client.plan_submitted_at && !client.allow_plan_edit) {
          delete updates.goal_statement;
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No writable fields' });
        // Locking the plan always ends the edit window. allow_plan_edit is intentionally
        // NOT client-writable (no privilege escalation), so the server clears it here when
        // the client submits their plan — otherwise an unlocked client loops back into the
        // wizard on reload instead of landing in their portal.
        if (updates.plan_submitted_at) updates.allow_plan_edit = false;
        const r = await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', updates, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Update failed', detail }); }
        return res.status(200).json({ ok: true });
      }

      // ── Profile avatar (client uploads their own photo) ─────────────────────
      // base64 data URL → public org-assets bucket → avatar_url. Server-set only,
      // scoped to THIS client. Mirrors the coach org-logo uploader.
      case 'upload-avatar': {
        const m = String(body.image_data_url || '').match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
        if (!m) return res.status(400).json({ error: 'Use a PNG, JPG, or WebP image.' });
        const mime = m[1];
        const buf = Buffer.from(m[3], 'base64');
        if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image is over 5 MB — pick a smaller one.' });
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        const path = `client-avatars/${clientId}.${ext}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/org-assets/${path}`, {
          method: 'POST',
          headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': mime, 'x-upsert': 'true' },
          body: buf,
        });
        if (!up.ok) { const e = await up.text().catch(() => ''); return res.status(500).json({ error: 'Photo upload failed', detail: e }); }
        const url = `${SUPABASE_URL}/storage/v1/object/public/org-assets/${path}?v=${Date.now()}`;
        await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { avatar_url: url }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, avatar_url: url });
      }
      case 'remove-avatar': {
        await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { avatar_url: null }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Vision save (specificity-gated) — Project #2, F3 ────────────────────
      case 'save-vision': {
        const raw = (body.vision || '').trim();
        const attempt = Number(body.attempt) || 0;   // number of PRIOR failed attempts
        if (!raw) return res.status(400).json({ error: 'Vision is empty' });
        if (raw.length > 400) return res.status(400).json({ error: 'Keep your vision to one line (400 characters max).' });

        const gate = await visionGate(raw);
        const forceAccept = attempt >= 2;             // after 2 failed revisions, accept + flag

        if (gate.pass || forceAccept) {
          const flagged = (!gate.pass && forceAccept);
          const r = await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', {
            vision_statement: raw,
            vision_last_edited_at: new Date().toISOString(),
            vision_flagged_for_review: flagged,
          }, { Prefer: 'return=minimal' });
          if (!r.ok) return res.status(500).json({ error: 'Could not save your vision' });
          return res.status(200).json({ ok: true, saved: true, flagged, vision: raw });
        }
        return res.status(200).json({ ok: true, saved: false,
          nudge: gate.nudge || 'That reads more like a milestone than a vision. What will your team actually DO differently, and how would you know? Add the observable part.' });
      }

      // ── Request a change to the (locked) 90-day goal — Project #2, F4 ────────
      case 'request-goal-change': {
        const note = (body.note || '').trim().slice(0, 1000);
        const r = await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', {
          goal_change_requested_at: new Date().toISOString(),
          goal_change_note: note || null,
        }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not submit your request' });
        // Notify the coach (best-effort — the request is recorded regardless).
        try {
          if (RESEND_API_KEY) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: `GPS Leadership Portal <${RESEND_FROM}>`,
                to: ['team@gpsleadership.org'],
                reply_to: client.email || undefined,
                subject: `Goal-change request — ${client.name || 'a client'}`,
                html: `<p><strong>${escapeHtml(client.name || 'A client')}</strong> requested a change to their 90-day goal.</p>${note ? '<p style="border-left:3px solid #01949A;padding-left:12px;color:#374151;"><em>' + escapeHtml(note) + '</em></p>' : ''}<p>Review and update it in their plan on the coach dashboard.</p>`,
              }),
            });
          }
        } catch (_) { /* email is best-effort */ }
        return res.status(200).json({ ok: true });
      }

      // ── Stakeholders ────────────────────────────────────────────────────────
      // ── Results tab data (post-lockdown read path; anon reads are dead) ─────
      case 'results-data': {
        const [ck, sr, st, sc, sh, cl] = await Promise.all([
          sb(`/rest/v1/checkins?client_id=eq.${clientId}&select=*&order=week_number.asc`),
          sb(`/rest/v1/survey_responses?client_id=eq.${clientId}&select=checkpoint,score,scale,open_response,comments,comments_visible_to_client,submitted_at&order=submitted_at.asc`),
          sb(`/rest/v1/survey_tokens?client_id=eq.${clientId}&select=checkpoint,non_response_flagged,is_used`),
          sb(`/rest/v1/self_checks?client_id=eq.${clientId}&select=checkpoint,q1_score,q2_score,q3_response,submitted_at`),
          sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=id,name,email,relationship,is_supervisor,is_board_member,confirmed_at,created_at&order=created_at.asc`),
          sb(`/rest/v1/clients?id=eq.${clientId}&select=coaching_program_start_date,plan_start_date,metric_target,metric_current,goal_30_day,goal_90_day,goal_statement,start_behavior,sponsor_outcome_focus,preferred_name,celebrated_30_at,celebrated_90_at&limit=1`),
        ]);
        const j = async (r) => (r.ok ? await r.json() : []);
        const clientRows = await j(cl);
        return res.status(200).json({
          ok: true,
          checkins: await j(ck),
          survey_responses: await j(sr),
          survey_tokens: await j(st),
          self_checks: await j(sc),
          stakeholders: await j(sh),
          milestone: clientRows[0] ? computeMilestoneState(clientRows[0]) : null,
        });
      }

      // ── Celebration seen: stamp so a goal-hit modal shows exactly once ───────
      case 'celebration-seen': {
        const phase = body.phase === 90 || body.phase === '90' ? 90 : (body.phase === 30 || body.phase === '30' ? 30 : null);
        if (!phase) return res.status(400).json({ error: 'phase must be 30 or 90' });
        const col = phase === 90 ? 'celebrated_90_at' : 'celebrated_30_at';
        await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { [col]: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Ask Alex history (post-lockdown read path; anon reads are dead) ─────
      case 'ask-history': {
        const r = await sb(`/rest/v1/ask_alex_log?client_id=eq.${clientId}&select=id,asked_at,question_text,response_text&order=asked_at.desc&limit=7`);
        if (!r.ok) return res.status(500).json({ error: 'Could not load history' });
        return res.status(200).json({ ok: true, history: await r.json() });
      }

      // ── Toolkit Library: favorites (My Tools, cross-device) + open logging ───
      case 'get-favorites': {
        const r = await sb(`/rest/v1/tool_favorites?client_id=eq.${clientId}&select=tool_id&order=created_at.desc`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, favorites: rows.map(function (x) { return x.tool_id; }) });
      }
      case 'toggle-favorite': {
        const toolId = String(body.tool_id || '').slice(0, 80);
        if (!toolId) return res.status(400).json({ error: 'tool_id required' });
        if (body.on) {
          await sb('/rest/v1/tool_favorites?on_conflict=client_id,tool_id', 'POST',
            { client_id: clientId, tool_id: toolId },
            { Prefer: 'resolution=ignore-duplicates,return=minimal' });
        } else {
          await sb(`/rest/v1/tool_favorites?client_id=eq.${clientId}&tool_id=eq.${encodeURIComponent(toolId)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }
      case 'tool-usage': {
        const toolId = String(body.tool_id || '').slice(0, 80);
        if (toolId) {
          await sb('/rest/v1/tool_usage', 'POST', { client_id: clientId, tool_id: toolId }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }

      // ── Contact Your Coach: read the client's own thread ────────────────────
      // Eligibility is enforced SERVER-side: non-coaching clients get eligible:false
      // and never see message rows. Scoped strictly to this client's conversation.
      case 'coach-thread-get': {
        if (!isCoachingClient(client)) return res.status(200).json({ ok: true, eligible: false });
        const cr = await sb(`/rest/v1/coach_conversations?client_id=eq.${clientId}&select=id,status,last_message_at&order=last_message_at.desc.nullslast&limit=1`);
        const convs = cr.ok ? await cr.json() : [];
        const conv = convs[0] || null;
        if (!conv) return res.status(200).json({ ok: true, eligible: true, conversation: null, messages: [] });
        const mr = await sb(`/rest/v1/coach_messages?conversation_id=eq.${conv.id}&select=id,sender_role,sender_name,message_type,message_text,created_at,read_by_client&order=created_at.asc`);
        const messages = mr.ok ? await mr.json() : [];
        // Mark coach replies as read by the client now that they're being viewed.
        await sb(`/rest/v1/coach_messages?conversation_id=eq.${conv.id}&sender_role=eq.coach&read_by_client=eq.false`, 'PATCH', { read_by_client: true }, { Prefer: 'return=minimal' }).catch(() => {});
        return res.status(200).json({ ok: true, eligible: true, conversation: conv, messages });
      }

      // ── Contact Your Coach: unread coach-message count (no mutation) ────────
      // Used on portal load to badge the tab BEFORE the client opens the thread
      // (opening it via coach-thread-get is what marks messages read).
      case 'coach-unread': {
        if (!isCoachingClient(client)) return res.status(200).json({ ok: true, unread: 0 });
        const cr = await sb(`/rest/v1/coach_conversations?client_id=eq.${clientId}&select=id`);
        const convs = cr.ok ? await cr.json() : [];
        if (!convs.length) return res.status(200).json({ ok: true, unread: 0 });
        const ids = convs.map(c => `"${c.id}"`).join(',');
        const mr = await sb(`/rest/v1/coach_messages?conversation_id=in.(${ids})&sender_role=eq.coach&read_by_client=eq.false&select=id`);
        const rows = mr.ok ? await mr.json() : [];
        return res.status(200).json({ ok: true, unread: Array.isArray(rows) ? rows.length : 0 });
      }

      // ── Contact Your Coach: client sends a message ──────────────────────────
      case 'coach-message-send': {
        if (!isCoachingClient(client)) return res.status(403).json({ error: 'Messaging is available to active coaching clients only.' });
        const text = (body.message_text || '').toString().trim();
        if (!text) return res.status(400).json({ error: 'Message text is required.' });
        if (text.length > 5000) return res.status(400).json({ error: 'Message is too long (5000 character max).' });
        const msgType = COACH_MSG_TYPES.has(body.message_type) ? body.message_type : 'quick_question';
        const now = new Date().toISOString();

        // Reuse the client's latest conversation (reopen if it was closed) so the
        // thread stays continuous; create one only if none exists.
        const cr = await sb(`/rest/v1/coach_conversations?client_id=eq.${clientId}&select=id&order=last_message_at.desc.nullslast&limit=1`);
        const convs = cr.ok ? await cr.json() : [];
        let convId = convs[0] && convs[0].id;
        if (convId) {
          await sb(`/rest/v1/coach_conversations?id=eq.${convId}`, 'PATCH', { status: 'open', last_message_at: now, updated_at: now }, { Prefer: 'return=minimal' });
        } else {
          const ins = await sb('/rest/v1/coach_conversations', 'POST', { client_id: clientId, status: 'open', last_message_at: now }, { Prefer: 'return=representation' });
          if (!ins.ok) { const d = await ins.json().catch(() => ({})); return res.status(500).json({ error: 'Could not start conversation', detail: d }); }
          const rows = await ins.json();
          convId = (Array.isArray(rows) ? rows[0] : rows).id;
        }

        const mr = await sb('/rest/v1/coach_messages', 'POST', {
          conversation_id: convId, client_id: clientId, sender_role: 'client',
          message_type: msgType, message_text: text, read_by_coach: false, read_by_client: true, created_at: now,
        }, { Prefer: 'return=representation' });
        if (!mr.ok) { const d = await mr.json().catch(() => ({})); return res.status(500).json({ error: 'Could not send message', detail: d }); }
        const saved = await mr.json();

        // ── Notify Alex by email — non-blocking, never breaks the client send ──
        if (RESEND_API_KEY) {
          const clientName = client.name || client.email || 'A client';
          const preview    = text.length > 200 ? text.slice(0, 200) + '…' : text;
          const typeLabels = { quick_question: 'Quick question', prep_for_session: 'Session prep', progress_update: 'Update', win: 'Win', logistics: 'Logistics', reschedule: 'Reschedule session' };
          const typeLabel  = typeLabels[msgType] || msgType;
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    `GPS Leadership Portal <${RESEND_FROM}>`,
              to:      [COACH_EMAIL],
              subject: `New message from ${clientName} [${typeLabel}]`,
              html:    `<p><strong>${clientName}</strong> sent you a message in the Executive Impact System:</p>`
                     + `<blockquote style="border-left:3px solid #004369;margin:12px 0;padding:8px 16px;color:#333;font-size:15px;">${preview.replace(/\n/g,'<br>')}</blockquote>`
                     + `<p><a href="https://portal.gpsleadership.org/coach" style="background:#004369;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Open &amp; reply →</a></p>`,
              text:    `${clientName} sent a message [${typeLabel}]:\n\n${text}\n\nReply at: https://portal.gpsleadership.org/coach`,
            }),
          }).catch(() => {}); // fire-and-forget
        }

        return res.status(200).json({ ok: true, message: Array.isArray(saved) ? saved[0] : saved });
      }

      case 'get-stakeholders': {
        const r = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=*`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, stakeholders: rows });
      }
      case 'add-stakeholders': {
        const list = Array.isArray(body.stakeholders) ? body.stakeholders : [];
        const clean = list.filter(s => s && s.name && s.email)
          .map(s => ({
            client_id: clientId, name: s.name, email: s.email, relationship: s.relationship || null,
            is_supervisor: (s.is_supervisor != null) ? !!s.is_supervisor : (s.relationship === 'Manager'),
            is_board_member: !!s.is_board_member,
            is_active: true, added_by: s.added_by || 'client_portal',
          }));
        if (clean.length === 0) return res.status(200).json({ ok: true, inserted: 0 });
        // de-dupe against existing active emails for this client
        const er = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=email`);
        const existing = new Set((er.ok ? await er.json() : []).map(s => (s.email || '').toLowerCase()));
        const toInsert = clean.filter(s => !existing.has(s.email.toLowerCase()));
        if (toInsert.length === 0) return res.status(200).json({ ok: true, inserted: 0 });
        const r = await sb('/rest/v1/stakeholders', 'POST', toInsert, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Insert failed', detail }); }
        return res.status(200).json({ ok: true, inserted: toInsert.length });
      }
      case 'update-stakeholder': {
        // scope: only a stakeholder belonging to this client
        const r = await sb(`/rest/v1/stakeholders?id=eq.${encodeURIComponent(body.stakeholder_id)}&client_id=eq.${clientId}`, 'PATCH', body.updates || {}, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Update failed' });
        return res.status(200).json({ ok: true });
      }
      case 'deactivate-stakeholder': {
        // soft-delete, only if still a draft (confirmed_at IS NULL), scoped to this client
        await sb(`/rest/v1/stakeholders?id=eq.${encodeURIComponent(body.stakeholder_id)}&client_id=eq.${clientId}&confirmed_at=is.null`, 'PATCH', { is_active: false }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'confirm-stakeholders': {
        const r = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&confirmed_at=is.null`, 'PATCH', { confirmed_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not confirm stakeholders' });
        return res.status(200).json({ ok: true });
      }

      // ── Self checks ─────────────────────────────────────────────────────────
      case 'add-self-check': {
        const sc = body.self_check || {};
        sc.client_id = clientId;
        const r = await sb('/rest/v1/self_checks', 'POST', sc, { Prefer: 'return=minimal' });
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          // 23505 = unique violation → already submitted (frontend treats as benign)
          if (detail && detail.code === '23505') return res.status(200).json({ ok: false, duplicate: true });
          return res.status(500).json({ error: 'Could not save self-check', detail });
        }
        return res.status(200).json({ ok: true });
      }

      // ── Activity / lifecycle stamps ─────────────────────────────────────────
      case 'touch-activity': {
        await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { last_active_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'set-first-active': {
        // set portal_first_active_at only if not already set
        await sb(`/rest/v1/clients?id=eq.${clientId}&portal_first_active_at=is.null`, 'PATCH', { portal_first_active_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Sponsor link: is this client also an executive sponsor? ─────────────
      // Matches the client's email to a sponsor record so their portal can show a
      // Decision Room tab instead of a separate link. Returns the sponsor token
      // (their own access) only to the authenticated, email-matched client.
      case 'get-my-sponsor': {
        const email = (client.email || '').trim();
        if (!email) return res.status(200).json({ ok: true, sponsor: null });
        const sp = await sb(`/rest/v1/sponsors?email=ilike.${encodeURIComponent(email.replace(/([\\%_])/g, '\\$1'))}&select=id,sponsor_token,name&limit=1`);
        const sprows = sp.ok ? await sp.json() : [];
        const sponsor = sprows[0];
        if (!sponsor || !sponsor.sponsor_token) return res.status(200).json({ ok: true, sponsor: null });
        const lt = await sb(`/rest/v1/sponsor_teams?sponsor_id=eq.${encodeURIComponent(sponsor.id)}&select=team_id`);
        const links = lt.ok ? await lt.json() : [];
        return res.status(200).json({ ok: true, sponsor: { token: sponsor.sponsor_token, name: sponsor.name, team_count: links.length } });
      }

      // ── Diagnostic (leader self-service rater list) ─────────────────────────
      case 'diag-get': {
        // The leader's latest diagnostic + raters + finalized report draft, scoped
        // to this client. Replaces the old anon db.from reads (dead post-v26).
        const r = await sb(`/rest/v1/diagnostics?client_id=eq.${clientId}&select=*&order=created_at.desc&limit=1`);
        const rows = r.ok ? await r.json() : [];
        const diag = rows[0] || null;
        if (!diag) return res.status(200).json({ ok: true, diagnostic: null });
        const rr = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${encodeURIComponent(diag.id)}&select=*&order=created_at.asc`);
        const raters = rr.ok ? await rr.json() : [];
        let report = null;
        if (diag.report_finalized_at) {
          const dr = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${encodeURIComponent(diag.id)}&select=*&order=generated_at.desc&limit=1`);
          const drows = dr.ok ? await dr.json() : [];
          report = drows[0] || null;
        }
        // report_doc is the coach-authored structured report. Only LEADER-facing
        // sections (audience client|all) may reach the client browser; any
        // sponsor/coach-only sections are stripped server-side (never rely on the
        // UI to hide them). Empty-body sections are dropped so the snapshot only
        // shows authored content.
        if (diag.report_doc && Array.isArray(diag.report_doc.sections)) {
          diag.report_doc = Object.assign({}, diag.report_doc, {
            sections: diag.report_doc.sections.filter(function (s) {
              const aud = (s && s.audience) || 'client';
              return (aud === 'client' || aud === 'all') && s && typeof s.body === 'string' && s.body.trim().length > 0;
            }),
          });
        }
        // Recommendations: surface the leader's team recommendations that the coach
        // has BOTH approved and released to clients, AND that the sponsor has committed
        // to ("I'm in"). Only sponsor-committed recs reach the leader — pending or passed
        // recs stay hidden until the sponsor session happens.
        let recommendations = [];
        try {
          const tmRes = await sb(`/rest/v1/team_members?client_id=eq.${encodeURIComponent(clientId)}&select=team_id`);
          const tms = tmRes.ok ? await tmRes.json() : [];
          const teamIds = Array.from(new Set((Array.isArray(tms) ? tms : []).map(function (t) { return t.team_id; }).filter(Boolean)));
          if (teamIds.length) {
            const inList = teamIds.map(function (id) { return encodeURIComponent(id); }).join(',');
            // Fetch recs with id so we can cross-check sponsor commitments
            const rc = await sb(`/rest/v1/recommendations?team_id=in.(${inList})&status=eq.approved&visible_to_client=eq.true&select=id,short_title,description,owner,timeframe,category,target_band,quick_start_today,quick_start_week,updated_at&order=updated_at.desc`);
            const allRecs = rc.ok ? await rc.json() : [];
            // Collect rec IDs the sponsor(s) have committed to across all teams
            const stRes = await sb(`/rest/v1/sponsor_teams?team_id=in.(${inList})&select=rec_commitments`);
            const stRows = stRes.ok ? await stRes.json() : [];
            const committedIds = new Set();
            for (const st of (Array.isArray(stRows) ? stRows : [])) {
              if (st.rec_commitments && typeof st.rec_commitments === 'object') {
                for (const [recId, decision] of Object.entries(st.rec_commitments)) {
                  if (decision === 'commit') committedIds.add(recId);
                }
              }
            }
            // Only show recs the sponsor clicked "I'm in" on
            recommendations = allRecs.filter(function (r) { return committedIds.has(r.id); });
          }
        } catch (_) { recommendations = []; }
        return res.status(200).json({ ok: true, diagnostic: diag, raters, report, recommendations });
      }

      case 'renewal-options': {
        // Which renewal/continuation offer (if any) to show this leader, plus the
        // editable GHL link + price from renewal_config. Cards stay hidden when the
        // relevant link is not configured yet, so nothing renders half-built.
        const cfgRes = await sb(`/rest/v1/renewal_config?id=eq.1&select=*&limit=1`);
        const cfg = (cfgRes.ok ? (await cfgRes.json())[0] : null) || {};
        const cRes = await sb(`/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=in_coaching_program,coaching_sessions_enabled,is_active_coaching,plan_start_date,payer_type,subscription_status&limit=1`);
        // Do NOT swallow a DB failure into show:false — that's exactly how the phantom-column
        // bug (P0-2) hid the whole offer path. A real query failure returns an error so the
        // synthetic monitor catches it; only a genuine "no such client" falls through. (2026-07-02)
        if (!cRes.ok) { const d = await cRes.text().catch(() => ''); return res.status(502).json({ ok: false, error: 'renewal client lookup failed', detail: String(d).slice(0, 200) }); }
        const client = (await cRes.json())[0] || null;
        if (!client) return res.status(200).json({ ok: true, show: false });
        // Canonical "active coaching client" test — matches isCoaching() at L69,
        // get-client.js:404, coach.html. Replaces the phantom is_coaching_client
        // column (P0-2, 2026-07-01 audit) that 400'd and hid every offer.
        const isCoachingClient = !!(client.in_coaching_program || client.coaching_sessions_enabled || client.is_active_coaching);
        const payer_type = client.payer_type || 'leader_pays';
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const addDays = function (d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
        const ymd = function (d) { return d.toISOString().slice(0, 10); };

        // Touchpoint B — continuation, for active coaching clients in/near sprint end.
        if (isCoachingClient) {
          const spRes = await sb(`/rest/v1/sprints?client_id=eq.${encodeURIComponent(clientId)}&select=start_date,end_date,sprint_number,status&order=sprint_number.desc&limit=1`);
          const sp = spRes.ok ? (await spRes.json())[0] : null;
          const start = (sp && sp.start_date) ? new Date(sp.start_date) : (client.plan_start_date ? new Date(client.plan_start_date) : null);
          if (start && !isNaN(start)) {
            const end = (sp && sp.end_date) ? new Date(sp.end_date) : addDays(start, 90);
            const day75 = addDays(end, -15);
            const graceEnd = addDays(end, cfg.grace_window_days || 7);
            if (today >= day75 && today <= graceEnd) {
              return res.status(200).json({
                ok: true, show: true, touchpoint: 'continuation', payer_type,
                sprint_end: ymd(end),
                titan: cfg.continuation_titan_url ? { url: cfg.continuation_titan_url, price: cfg.price_titan_quarterly } : null,
                flex:  cfg.continuation_flex_url  ? { url: cfg.continuation_flex_url,  price: cfg.price_flex_monthly  } : null,
              });
            }
          }
          return res.status(200).json({ ok: true, show: false });
        }

        // Touchpoint A — diagnostic → first coaching sprint (credit window).
        const dRes = await sb(`/rest/v1/diagnostics?client_id=eq.${encodeURIComponent(clientId)}&select=debrief_date,status&order=created_at.desc&limit=1`);
        const diagRow = dRes.ok ? (await dRes.json())[0] : null;
        if (diagRow && diagRow.debrief_date) {
          const creditEnds = addDays(new Date(diagRow.debrief_date), cfg.credit_window_days || 30);
          const inWindow = today <= creditEnds;
          const url = inWindow ? cfg.first_sprint_credit_url : cfg.first_sprint_standard_url;
          return res.status(200).json({
            ok: true, show: !!url, touchpoint: 'first_sprint', payer_type,
            in_credit_window: inWindow,
            credit_window_ends: ymd(creditEnds),
            price: inWindow ? cfg.price_first_credit : cfg.price_first_standard,
            url: url || null,
          });
        }
        return res.status(200).json({ ok: true, show: false });
      }
      case 'diag-get-raters': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const r = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${encodeURIComponent(body.diagnostic_id)}&select=*&order=created_at.asc`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, raters: rows });
      }
      case 'diag-add-rater': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const rt = body.rater || {};
        const r = await sb('/rest/v1/diagnostic_raters', 'POST', {
          diagnostic_id: body.diagnostic_id, name: rt.name, email: rt.email,
          relationship: rt.relationship || null, is_self: false,
        }, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add rater', detail }); }
        return res.status(200).json({ ok: true });
      }
      case 'diag-remove-rater': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        // only remove a rater that belongs to this diagnostic and isn't completed
        await sb(`/rest/v1/diagnostic_raters?id=eq.${encodeURIComponent(body.rater_id)}&diagnostic_id=eq.${encodeURIComponent(body.diagnostic_id)}&completed_at=is.null`, 'DELETE', null, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'diag-finalize-raters': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(body.diagnostic_id)}`, 'PATCH', {
          raters_finalized_at: new Date().toISOString(), status: 'rater_setup',
        }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not submit rater list' });
        return res.status(200).json({ ok: true });
      }

      // ── Workshop sponsor tab: return workshops this client sponsors ──────────
      case 'my-workshops': {
        // Look up workshop_sponsors rows for this client
        const enc = encodeURIComponent;
        const links = await (async () => {
          const r = await sb(`/rest/v1/workshop_sponsors?client_id=eq.${enc(clientId)}&select=workshop_id,added_at,access_token`);
          if (!r.ok) return [];
          return (await r.json().catch(() => [])) || [];
        })();
        if (!links.length) return res.status(200).json({ ok: true, workshops: [] });
        // Fetch each workshop — only surface-safe fields (no raw data, no survey content)
        const workshops = (await Promise.all(links.map(async l => {
          const r = await sb(`/rest/v1/workshops?id=eq.${enc(l.workshop_id)}&select=id,title,engagement_kind,status,workshop_date,client_org_name,roster_locked,roster_file_url,roster_uploaded_at,organization_id,sponsor_token&limit=1`);
          if (!r.ok) return null;
          const rows = await r.json().catch(() => []);
          const w = Array.isArray(rows) ? rows[0] : rows;
          if (!w) return null;
          // Fetch org logo if org is linked
          let org_logo_url = null;
          if (w.organization_id) {
            const orgR = await sb(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=logo_url&limit=1`);
            if (orgR.ok) {
              const orgRows = await orgR.json().catch(() => []);
              org_logo_url = (Array.isArray(orgRows) ? orgRows[0] : orgRows)?.logo_url || null;
            }
          }
          // Participant count (sponsor sees this but not individual names/data)
          const countR = await sb(`/rest/v1/workshop_participants?workshop_id=eq.${enc(w.id)}&select=id`);
          const countRows = countR.ok ? (await countR.json().catch(() => [])) : [];
          // The sponsor's own status dashboard link, built server-side. The raw token
          // is not surfaced as its own field — only the ready-to-open URL.
          const PORTAL = process.env.PORTAL_BASE_URL || 'https://portal.gpsleadership.org';
          // Prefer the sponsor's OWN per-sponsor token; fall back to the workshop's shared one.
          const dashTok = l.access_token || w.sponsor_token;
          const dashboard_url = dashTok ? `${PORTAL}/workshop-room?token=${encodeURIComponent(dashTok)}` : null;
          const { sponsor_token, ...wSafe } = w;
          return {
            ...wSafe,
            dashboard_url,
            org_logo_url,
            participant_count: Array.isArray(countRows) ? countRows.length : 0,
            sponsor_added_at: l.added_at,
          };
        }))).filter(Boolean);
        return res.status(200).json({ ok: true, workshops });
      }

      // ── Sponsor: upload/replace participant roster (before lock only) ─────────
      case 'sponsor-upload-roster': {
        const enc = encodeURIComponent;
        const wid  = body.workshop_id;
        const rows = Array.isArray(body.participants) ? body.participants : (Array.isArray(body.rows) ? body.rows : []);
        if (!wid) return res.status(400).json({ error: 'workshop_id required' });
        // Verify this client is actually a sponsor for this workshop
        const linkR = await sb(`/rest/v1/workshop_sponsors?workshop_id=eq.${enc(wid)}&client_id=eq.${enc(clientId)}&select=workshop_id&limit=1`);
        const linkRows = linkR.ok ? (await linkR.json().catch(() => [])) : [];
        if (!Array.isArray(linkRows) || !linkRows.length) return res.status(403).json({ error: 'Not a sponsor for this workshop' });
        // Check roster is not locked
        const w = await (async () => {
          const r = await sb(`/rest/v1/workshops?id=eq.${enc(wid)}&select=roster_locked&limit=1`);
          if (!r.ok) return null;
          const wr = await r.json().catch(() => []);
          return Array.isArray(wr) ? wr[0] : wr;
        })();
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        if (w.roster_locked) return res.status(403).json({ error: 'Roster is locked. Contact Alex to make changes.' });
        if (!rows.length) return res.status(400).json({ error: 'No rows provided' });
        // Upsert participants (same logic as coach upload-roster)
        let created = 0, linked = 0, skipped = 0;
        for (const raw of rows) {
          const name  = ((raw.first_name || '') + ' ' + (raw.last_name || '')).trim() || (raw.name || '').trim();
          const email = (raw.email || '').trim().toLowerCase();
          if (!email || !name) { skipped++; continue; }
          let client = await (async () => {
            const r = await sb(`/rest/v1/clients?email=eq.${enc(email)}&select=id&limit=1`);
            if (!r.ok) return null;
            const cr = await r.json().catch(() => []);
            return Array.isArray(cr) ? cr[0] : cr;
          })();
          if (!client) {
            const ins = await sb('/rest/v1/clients', 'POST', {
              name, email, title: raw.role_title || raw.role || raw.title || null,
              is_workshop_participant: true, in_coaching_program: false, is_active: true,
            }, { Prefer: 'return=representation' });
            const cr = await ins.json().catch(() => []);
            client = Array.isArray(cr) ? cr[0] : cr;
            if (!client?.id) { skipped++; continue; }
            created++;
          }
          const linkIns = await sb(`/rest/v1/workshop_participants?on_conflict=workshop_id,client_id`, 'POST', {
            workshop_id: wid, client_id: client.id,
            role: raw.role_title || raw.role || raw.title || null,
            location: raw.location || raw.region || null,
            department: raw.department || null,
          }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
          if (linkIns.ok) linked++; else skipped++;
        }
        // Mark file uploaded timestamp
        await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH',
          { roster_uploaded_at: new Date().toISOString() },
          { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, created, linked, skipped });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
