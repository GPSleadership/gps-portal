// GPS Leadership Solutions — Survey API (consolidated)
// Routes send + submit through a single serverless function.
//
// POST /api/survey?action=send   — coach-triggered survey send
// POST /api/survey?action=submit — stakeholder survey submission
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SECRET_KEY   — Supabase service role key
//   RESEND_API_KEY        — Resend API key
//   SITE_URL              — Portal base URL (default: https://portal.gpsleadership.org)

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const SITE_URL        = process.env.SITE_URL        || 'https://portal.gpsleadership.org';
const CRON_SECRET     = process.env.CRON_SECRET || '';
const FROM_EMAIL      = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';
const FROM_NAME       = 'Alex Tremble | GPS Leadership Solutions';
const ALEX_EMAIL      = 'alex@gpsleadership.org';
// Cron heartbeat — lets detect_breakages() flag this job if it goes silent. (2026-07-02)
async function recordHeartbeat(name, status = 'ok', detail = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeats?on_conflict=cron_name`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cron_name: name, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail, updated_at: new Date().toISOString() }),
    });
  } catch (_) { /* best-effort */ }
}
// Deliverability: text/plain part alongside HTML (improves inbox placement).
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Supabase fetch helper ────────────────────────────────────────────────────
function sbFetch(path, method = 'GET', body = null, extraHeaders = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

// Configurable CC for survey emails — global toggles (email_cc_settings) + per-client
// project CCs. Falls back to leader+team+alex if the config can't be read.
async function loadCcConfig() {
  try {
    const r = await sbFetch('/rest/v1/email_cc_settings?id=eq.1&select=cc_leader,cc_team,cc_alex,extra_cc&limit=1');
    if (r.ok) { const rows = await r.json(); if (Array.isArray(rows) && rows[0]) return rows[0]; }
  } catch (_) {}
  return { cc_leader: true, cc_team: true, cc_alex: true, extra_cc: [] };
}
function buildCcList(cfg, leaderEmail, projectCc) {
  const out = [];
  if (cfg.cc_leader && leaderEmail) out.push(leaderEmail);
  if (cfg.cc_team) out.push('team@gpsleadership.org');
  if (cfg.cc_alex) out.push('alex@gpsleadership.org');
  if (Array.isArray(cfg.extra_cc)) cfg.extra_cc.forEach(e => out.push(e));
  if (Array.isArray(projectCc)) projectCc.forEach(e => out.push(e));
  return out.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'get':    return handleGet(req, res);
    case 'send':   return handleSend(req, res);
    case 'schedule-send':  return handleScheduleSend(req, res);
    case 'schedule-pulses': return handleSchedulePulses(req, res);
    case 'send-scheduled': return handleSendScheduled(req, res);
    case 'resend': return handleResend(req, res);
    case 'submit': return handleSubmit(req, res);
    default:
      return res.status(400).json({ error: `Unknown action: "${action}". Valid: get, send, schedule-send, schedule-pulses, send-scheduled, resend, submit` });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: get — validate a stakeholder survey token and return its survey context.
// Replaces the dead browser anon-key lookup (anon can't read survey_tokens under
// the v26 RLS lockdown). Service key bypasses RLS; only the matching token row is
// returned, so a caller can't enumerate or read anyone else's data.
// POST /api/survey?action=get  { token }
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGet(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = (req.body && req.body.token) || req.query?.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const r = await sbFetch(`/rest/v1/survey_tokens?token=eq.${encodeURIComponent(token)}&select=*&limit=1`);
  if (!r.ok) return res.status(500).json({ error: 'Could not validate survey link' });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ error: 'Survey link not recognized' });
  return res.status(200).json({ ok: true, token: rows[0] });
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send
// POST /api/survey?action=send
// Body: { client_id, checkpoint, password }
// ═══════════════════════════════════════════════════════════════════════════════

function generateToken() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function buildSendSubjectLine(clientName, checkpoint) {
  const first = clientName.split(' ')[0];
  if (checkpoint === 'baseline') return `${first} would value your candid feedback`;
  if (checkpoint === 'day30')   return `Quick mid-point check-in for ${first}`;
  if (checkpoint === 'day45')   return `A quick pulse on ${first}'s progress`;
  return `Final 90-day feedback for ${first}`;
}

function buildSendEmailHtml(stakeholderName, clientName, checkpoint, priorityBehavior, surveyLink, progressNote) {
  const clientFirst = clientName.split(' ')[0];
  const p   = t => `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;
  const li  = t => `<li style="color:#1B2A4A;font-size:15px;line-height:1.75;margin-bottom:8px;">${t}</li>`;

  // Peak-end "here's the change" block — shows the stakeholder how far the leader
  // has already moved, so a repeat pulse feels like progress, not another cold ask.
  const progressBlock = progressNote
    ? `<div style="background:#EAF3F1;border-left:3px solid #0F6E56;padding:11px 16px;margin:14px 0;border-radius:0 6px 6px 0;font-size:14px;color:#0F3D30;line-height:1.65;">${progressNote}</div>`
    : '';

  const behaviorBlock = `
    <div style="background:#F5F6F8;border-left:3px solid #C9A84C;padding:11px 16px;margin:14px 0;border-radius:0 6px 6px 0;font-size:14px;color:#1B2A4A;font-style:italic;line-height:1.65;">
      "${priorityBehavior}"
    </div>`;

  let _surveyPaste = '';
  try { _surveyPaste = require('./brand-link').pasteLink(surveyLink, 'center'); } catch (_) {}
  const ctaBtn = `
    <div style="text-align:center;margin:28px 0;">
      <a href="${surveyLink}" style="display:inline-block;background:#1B2A4A;color:#FFFFFF;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;">
        Complete the Survey →
      </a>
    </div>
    ${_surveyPaste}
    <p style="color:#9CA3AF;font-size:12px;line-height:1.5;margin:8px 0 4px;text-align:center;">
      This link is unique to you and expires in 30 days.
    </p>`;

  const sig = `
    <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 18px;" />
    <p style="color:#4B5563;font-size:13px;line-height:1.7;margin:0;">
      Best,<br>
      <strong style="color:#1B2A4A;">Alex D. Tremble</strong><br>
      CEO &amp; Executive Advisor, GPS Leadership Solutions<br>
      On behalf of ${clientFirst}<br>
      <a href="mailto:team@gpsleadership.org" style="color:#1B2A4A;">team@gpsleadership.org</a>
    </p>`;

  let body = '';

  if (checkpoint === 'baseline') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`${clientFirst} has started a focused 90-day leadership sprint and has asked you to be one of their key stakeholders.`)}
      ${p(`You'll find a short 2-question survey below. It should take less than 3 minutes. You'll be asked to:`)}
      <ol style="margin:0 0 14px;padding-left:22px;">
        ${li(`Rate, on a 1–5 scale, how consistently ${clientFirst} has <strong>${priorityBehavior}</strong> over the last 2 weeks.`)}
        ${li(`(Optional) Share one brief example of how their current behavior around this affects you or the team.`)}
      </ol>
      ${ctaBtn}
      ${p(`This process is for development, not evaluation. Your numeric rating will be visible to both ${clientFirst} and their coach. For written comments, you can choose whether to share them with both of them or with the coach only.`)}
      ${p(`You'll notice ${clientFirst} and their coach are copied here so everyone knows this request was sent.`)}
      ${p(`Thank you in advance for your honest input — it's a key part of helping ${clientFirst} change in ways that matter.`)}`;
  } else if (checkpoint === 'day30') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`About 30 days ago, ${clientFirst} began a 90-day leadership sprint focused on:`)}
      ${behaviorBlock}
      ${p(`You previously shared baseline feedback as one of their key stakeholders.`)}
      ${p(`We're now at the midpoint and would value a quick update from you. Please complete this very short check-in (1 question):`)}
      ${ctaBtn}
      ${progressBlock}
      ${p(`You'll be asked to rate, on a 1–5 scale, how consistently ${clientFirst} has demonstrated the behavior above over the last 2 weeks, plus an optional comment field.`)}
      ${p(`Your numeric rating will be visible to both ${clientFirst} and their coach. For any written comments, you can again choose whether they are shared with both or only with the coach.`)}
      ${p(`${clientFirst} and their coach are copied here so everyone knows this request was sent. Your responses are still used for development, not formal evaluation.`)}
      ${p(`Thank you again for your support and candor.`)}`;
  } else if (checkpoint === 'day45') {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`${clientFirst} is partway through a 90-day leadership sprint focused on:`)}
      ${behaviorBlock}
      ${progressBlock}
      ${p(`We'd value another quick read from you. Please complete this short check-in (1 question):`)}
      ${ctaBtn}
      ${p(`You'll be asked to rate, on a 1–5 scale, how consistently ${clientFirst} has demonstrated the behavior above over the last 2 weeks, plus an optional comment.`)}
      ${p(`Your numeric rating is visible to both ${clientFirst} and their coach. Written comments follow the visibility setting you choose. This is for development, not evaluation.`)}
      ${p(`Thank you for staying involved — your steady input is what makes the change stick.`)}`;
  } else {
    body = `
      ${p(`Hi ${stakeholderName},`)}
      ${p(`You've been part of ${clientFirst}'s 90-day leadership sprint focused on:`)}
      ${behaviorBlock}
      ${progressBlock}
      ${p(`We're now at the final checkpoint. To help ${clientFirst} see what has actually changed from your perspective, please complete this brief survey:`)}
      ${ctaBtn}
      ${p(`You'll be asked to:`)}
      <ol style="margin:0 0 14px;padding-left:22px;">
        ${li(`Rate, on a 1–5 scale, how consistently ${clientFirst} has demonstrated the behavior above over the last 2 weeks.`)}
        ${li(`Share, in one sentence, the most noticeable change you've experienced in the last 2–4 weeks related to this behavior, with a brief example if possible.`)}
        ${li(`(Optional) Add any additional comments, with the option to share them with both ${clientFirst} and their coach, or with the coach only.`)}
      </ol>
      ${p(`As before, your numeric rating is visible to both ${clientFirst} and their coach. Written comments follow the visibility setting you choose. The purpose remains development, not performance evaluation.`)}
      ${p(`${clientFirst} and their coach are copied so they know this request has gone out. Your honest feedback is what makes this process meaningful.`)}
      ${p(`Thank you for your time and insight.`)}`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:36px 16px;">
    <div style="background:#1B2A4A;padding:20px 28px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#C9A84C;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#FFFFFF;font-size:15px;font-weight:500;opacity:0.8;">Leadership Development Program</div>
    </div>
    <div style="background:#FFFFFF;padding:30px 36px;border-radius:0 0 8px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      ${body}
      ${sig}
    </div>
  </div>
</body>
</html>`;
}

import crypto from 'node:crypto';
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
// Preferred auth: HMAC coach session (replaces the password read in the browser).
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

async function verifyPassword(password) {
  if (!password) return false;
  const settingsRes = await sbFetch('/rest/v1/coach_settings?key=eq.coach_password&select=value&limit=1');
  if (settingsRes.ok) {
    const settings = await settingsRes.json();
    if (settings && settings[0] && settings[0].value === password) return true;
  }
  const adminRes = await sbFetch('/rest/v1/admin_accounts?is_active=eq.true&select=password');
  if (adminRes.ok) {
    const admins = await adminRes.json();
    if ((admins || []).map(a => a.password).includes(password)) return true;
  }
  return false;
}

async function logEmail({ client_id, recipient_email, recipient_name, email_type, subject, status, error_details, resend_id }) {
  try {
    await sbFetch('/rest/v1/email_log', 'POST', {
      client_id, recipient_email, recipient_name, email_type, subject, status,
      error_details: error_details || null,
      resend_id:     resend_id    || null
    }, { 'Prefer': 'return=minimal' });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: schedule-pulses (coach session auth) — set a client's stakeholder-pulse
// cadence tier and (re)schedule the sprint's pulses into survey_schedules.
// Body: { client_id, tier: 'aggressive'|'light'|'off', session | password }
// Pulses are anchored to plan_start_date (fallback: today), at internal day
// 21/45/80, shifted to weekdays only. Idempotent. 'off' cancels all pending pulses.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSchedulePulses(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { client_id, tier, password } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    const authOk = !!verifyCoachSession(req.body?.session) || await verifyPassword(password);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    const cRes = await sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=id,name,plan_start_date,current_sprint_number,pulse_cadence_tier`);
    if (!cRes.ok) return res.status(500).json({ error: 'Failed to load client' });
    const rows = await cRes.json();
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = rows[0];

    const { schedulePulses, normalizeTier } = require('./pulse-schedule');
    const useTier = normalizeTier(tier != null ? tier : client.pulse_cadence_tier);

    // Persist the tier; a fresh coach-set cadence clears any prior auto-taper so
    // the taper window can start over (e.g. restarting an aggressive sprint).
    await sbFetch(`/rest/v1/clients?id=eq.${client_id}`, 'PATCH',
      { pulse_cadence_tier: useTier, pulse_tapered_at: null },
      { Prefer: 'return=minimal' });

    const anchor = client.plan_start_date || new Date().toISOString().split('T')[0];
    const result = await schedulePulses({
      client_id,
      tier: useTier,
      anchorDate: anchor,
      currentSprint: client.current_sprint_number || 1
    });

    return res.status(200).json({ ok: true, anchor, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Auto-taper evaluator. Cancels remaining scheduled pulses for a client's current
// sprint once the target behavior has scored an average of 4+/5 across raters on
// two consecutive MEASURED pulses. A pulse counts as "measured" once at least
// half of the active stakeholders (min 2) have responded, so a single early 5
// can't trip it. Sets clients.pulse_tapered_at so the coach UI can show why the
// cadence stopped early. Safe to call on every submit (idempotent, guarded).
async function maybeAutoTaper(client_id, sprintNumber) {
  try {
    const cRes = await sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=id,pulse_tapered_at`);
    if (!cRes.ok) return;
    const crows = await cRes.json();
    if (!crows || !crows.length) return;
    if (crows[0].pulse_tapered_at) return; // already tapered

    const shRes = await sbFetch(`/rest/v1/stakeholders?client_id=eq.${client_id}&is_active=eq.true&select=id`);
    const activeCount = shRes.ok ? (await shRes.json()).length : 0;
    if (activeCount < 2) return; // not enough raters to judge "across raters"
    const quorum = Math.max(2, Math.ceil(activeCount / 2));

    const rRes = await sbFetch(`/rest/v1/survey_responses?client_id=eq.${client_id}&sprint_number=eq.${sprintNumber}&checkpoint=in.(day30,day45,day90)&select=checkpoint,score`);
    if (!rRes.ok) return;
    const responses = await rRes.json();

    const order = ['day30', 'day45', 'day90'];
    const byCp = {};
    for (const r of (responses || [])) {
      (byCp[r.checkpoint] = byCp[r.checkpoint] || []).push(Number(r.score));
    }
    // Measured pulses in send order, with their average.
    const measured = order
      .filter(cp => (byCp[cp] || []).length >= quorum)
      .map(cp => ({ cp, avg: byCp[cp].reduce((a, b) => a + b, 0) / byCp[cp].length }));

    if (measured.length < 2) return;
    const lastTwo = measured.slice(-2);
    if (lastTwo[0].avg >= 4 && lastTwo[1].avg >= 4) {
      const { cancelRemainingPulses } = require('./pulse-schedule');
      await cancelRemainingPulses(client_id);
      await sbFetch(`/rest/v1/clients?id=eq.${client_id}`, 'PATCH',
        { pulse_tapered_at: new Date().toISOString() },
        { Prefer: 'return=minimal' });
    }
  } catch (_) { /* taper must never break a submit */ }
}

// Builds the peak-end progress sentence for a pulse email: how the leader's
// average rating on the target behavior has moved from baseline to the most
// recent measured pulse. Returns '' for the first pulse or when data is thin.
async function buildProgressNote(client_id, sprintNumber, checkpoint, clientFirst) {
  try {
    if (checkpoint !== 'day45' && checkpoint !== 'day90') return '';
    const rRes = await sbFetch(`/rest/v1/survey_responses?client_id=eq.${client_id}&sprint_number=eq.${sprintNumber}&select=checkpoint,score`);
    if (!rRes.ok) return '';
    const responses = await rRes.json();
    const avgOf = cp => {
      const s = (responses || []).filter(r => r.checkpoint === cp).map(r => Number(r.score));
      return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    };
    const baseline = avgOf('baseline');
    // Most recent prior pulse before the one being sent now.
    const priorOrder = checkpoint === 'day90' ? ['day45', 'day30'] : ['day30'];
    let latest = null;
    for (const cp of priorOrder) { const v = avgOf(cp); if (v != null) { latest = v; break; } }
    if (baseline == null || latest == null) return '';
    const b = baseline.toFixed(1), l = latest.toFixed(1);
    if (latest > baseline) {
      return `Since the baseline, stakeholder ratings of ${clientFirst} on this behavior have risen from ${b} to ${l} (1–5 scale). Your read below helps confirm whether that change is holding.`;
    }
    return `Stakeholder ratings of ${clientFirst} on this behavior are currently averaging ${l} of 5 (baseline was ${b}). Your candid read below matters most where progress is still in motion.`;
  } catch (_) { return ''; }
}

async function handleSend(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { client_id, checkpoint = 'baseline', password } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    const validCheckpoints = ['baseline', 'day30', 'day45', 'day90'];
    if (!validCheckpoints.includes(checkpoint)) {
      return res.status(400).json({ error: 'checkpoint must be baseline, day30, or day90' });
    }

    const authOk = !!verifyCoachSession(req.body.session);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    const r = await performSend(client_id, checkpoint);
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
    return res.status(200).json(r.results);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Core stakeholder send — shared by handleSend (manual) and handleSendScheduled (cron).
// Returns { ok:true, results } or { ok:false, status, error }. No HTTP here.
async function performSend(client_id, checkpoint) {
  const clientRes = await sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=id,name,email,behavior_1,start_behavior,current_sprint_number,observable_measure,organization,industry,gs_grade,project_cc_emails`);
  if (!clientRes.ok) return { ok:false, status:500, error:'Failed to load client' };
  const clients = await clientRes.json();
  if (!clients || clients.length === 0) return { ok:false, status:404, error:'Client not found' };
  const client = clients[0];
  const ccCfg = await loadCcConfig();

  const priorityBehavior = (client.observable_measure || client.behavior_1 || client.start_behavior || '').trim();
  if (!priorityBehavior) {
    return { ok:false, status:400, error:'This client has no priority behavior on file. Have them complete their 90-day plan before sending surveys.' };
  }

  const clientFirstName = (client.name || '').split(' ')[0];
  const sprintNumber    = client.current_sprint_number || 1;

  // Peak-end: for the 2nd/3rd pulses, show stakeholders how far the leader has
  // already moved since baseline (computed once, reused for the whole batch).
  const progressNote = await buildProgressNote(client_id, sprintNumber, checkpoint, clientFirstName);

  const stakeholderRes = await sbFetch(`/rest/v1/stakeholders?client_id=eq.${client_id}&is_active=eq.true&select=*`);
  if (!stakeholderRes.ok) return { ok:false, status:500, error:'Failed to load stakeholders' };
  const stakeholders = await stakeholderRes.json();
  if (!stakeholders || stakeholders.length === 0) {
    return { ok:false, status:400, error:'No active stakeholders found for this client' };
  }

  const existingRes    = await sbFetch(`/rest/v1/survey_tokens?client_id=eq.${client_id}&checkpoint=eq.${checkpoint}&sprint_number=eq.${sprintNumber}&select=stakeholder_id`);
  const existing       = existingRes.ok ? await existingRes.json() : [];
  const alreadySentIds = new Set((existing || []).map(t => t.stakeholder_id));

  const results = { sent: [], skipped: [], errors: [] };

  for (const stakeholder of stakeholders) {
    if (alreadySentIds.has(stakeholder.id)) {
      results.skipped.push({ name: stakeholder.name, reason: 'Already sent for this checkpoint' });
      continue;
    }

    const token   = generateToken();
    const now     = new Date().toISOString();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const tokenInsert = await sbFetch('/rest/v1/survey_tokens', 'POST', {
      token, client_id, stakeholder_id: stakeholder.id, checkpoint,
      priority_behavior: priorityBehavior, client_first_name: clientFirstName,
      sprint_number: sprintNumber, sent_at: now, expires_at: expires, is_used: false
    }, { 'Prefer': 'return=minimal' });

    if (!tokenInsert.ok) {
      const errText = await tokenInsert.text();
      results.errors.push({ name: stakeholder.name, error: 'Failed to create token: ' + errText.slice(0, 200) });
      continue;
    }

    const surveyLink = `${SITE_URL}/survey?t=${token}`;
    // CC per the configurable global toggles + this client's project CCs.
    const ccAddresses = buildCcList(ccCfg, client.email, client.project_cc_emails);
    const _bl = require('./brand-link');
    const _html = _bl.autoLinkBrand(buildSendEmailHtml(stakeholder.name, client.name, checkpoint, priorityBehavior, surveyLink, progressNote), _bl.gpsDiagnosticLink(client));
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${FROM_NAME} <${FROM_EMAIL}>`,
        to:      [stakeholder.email],
        cc:      ccAddresses,
        subject: buildSendSubjectLine(client.name, checkpoint),
        html:    _html,
        text:    htmlToText(_html),
        reply_to: ALEX_EMAIL
      })
    });

    if (emailRes.ok) {
      const emailData = await emailRes.json();
      await logEmail({ client_id, recipient_email: stakeholder.email, recipient_name: stakeholder.name, email_type: `survey_${checkpoint}`, subject: buildSendSubjectLine(client.name, checkpoint), status: 'sent', resend_id: emailData.id || null });
      results.sent.push({ name: stakeholder.name, email: stakeholder.email });
    } else {
      const errText = await emailRes.text();
      await logEmail({ client_id, recipient_email: stakeholder.email, recipient_name: stakeholder.name, email_type: `survey_${checkpoint}`, subject: buildSendSubjectLine(client.name, checkpoint), status: 'error', error_details: errText.slice(0, 500) });
      results.errors.push({ name: stakeholder.name, error: 'Email delivery failed' });
    }
  }

  return { ok:true, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: schedule-send (coach session auth) — set or cancel a future stakeholder send.
// Body: { client_id, checkpoint='baseline', scheduled_at (ISO | null to cancel), session }
// Replaces any existing pending schedule for this client+checkpoint.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleScheduleSend(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { client_id, checkpoint = 'baseline', scheduled_at, password } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id is required' });
    const validCheckpoints = ['baseline', 'day30', 'day45', 'day90'];
    if (!validCheckpoints.includes(checkpoint)) return res.status(400).json({ error: 'invalid checkpoint' });
    const authOk = !!verifyCoachSession(req.body.session);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    // Replace semantics: clear any existing pending schedule first.
    await sbFetch(`/rest/v1/survey_schedules?client_id=eq.${client_id}&checkpoint=eq.${checkpoint}&sent_at=is.null`, 'DELETE', null, { Prefer: 'return=minimal' });

    if (!scheduled_at) return res.status(200).json({ ok: true, scheduled_at: null });

    const when = new Date(scheduled_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduled_at' });
    if (when.getTime() < Date.now() - 60000) return res.status(400).json({ error: 'scheduled_at must be in the future' });

    const ins = await sbFetch('/rest/v1/survey_schedules', 'POST',
      { client_id, checkpoint, scheduled_at: when.toISOString() },
      { Prefer: 'return=minimal' });
    if (!ins.ok) { const e = await ins.text(); return res.status(500).json({ error: e.slice(0, 200) }); }
    return res.status(200).json({ ok: true, scheduled_at: when.toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send-scheduled (cron auth: x-vercel-cron / CRON_SECRET / coach session)
// Dispatches any stakeholder surveys whose scheduled time has passed. Claim column
// prevents overlapping runs; the per-stakeholder already-sent guard in performSend
// prevents double emails even if a claim is released for retry.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSendScheduled(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isManual     = req.method === 'POST' && !!verifyCoachSession(req.body?.session);
  const authHeader   = req.headers['authorization'] || '';
  const hasSecret    = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManual && !hasSecret) return res.status(401).json({ error: 'Unauthorized' });

  const nowISO = new Date().toISOString();
  const log = { processed: [], skipped: [], errors: [] };
  try {
    const dueRes = await sbFetch(`/rest/v1/survey_schedules?scheduled_at=lte.${nowISO}&sent_at=is.null&claimed_at=is.null&select=id,client_id,checkpoint&order=scheduled_at.asc&limit=50`);
    const due = dueRes.ok ? (await dueRes.json() || []) : [];
    for (const s of due) {
      const claimRes = await sbFetch(`/rest/v1/survey_schedules?id=eq.${s.id}&claimed_at=is.null`, 'PATCH', { claimed_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      const claimed = claimRes.ok ? await claimRes.json() : [];
      if (!Array.isArray(claimed) || claimed.length === 0) { log.skipped.push({ id: s.id, reason: 'already claimed' }); continue; }
      try {
        const r = await performSend(s.client_id, s.checkpoint);
        if (r.ok) {
          await sbFetch(`/rest/v1/survey_schedules?id=eq.${s.id}`, 'PATCH', { sent_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
          log.processed.push({ id: s.id, client_id: s.client_id, sent: (r.results.sent || []).length });
        } else {
          await sbFetch(`/rest/v1/survey_schedules?id=eq.${s.id}`, 'PATCH', { claimed_at: null }, { Prefer: 'return=minimal' });
          log.skipped.push({ id: s.id, reason: r.error });
        }
      } catch (err) {
        await sbFetch(`/rest/v1/survey_schedules?id=eq.${s.id}`, 'PATCH', { claimed_at: null }, { Prefer: 'return=minimal' });
        log.errors.push({ id: s.id, error: err.message });
      }
    }
    await recordHeartbeat('survey-send-scheduled', log.errors.length ? 'error' : 'ok', `processed ${log.processed.length}, errors ${log.errors.length}`);
    return res.status(200).json({ ok: true, due: due.length, ...log });
  } catch (err) {
    await recordHeartbeat('survey-send-scheduled', 'error', String(err.message || err).slice(0, 200));
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: resend
// POST /api/survey?action=resend
// Body: { client_id, stakeholder_id, checkpoint, password }
// Deletes existing unused token for this stakeholder+checkpoint, creates a new
// one, and resends the survey email. Used for individual resend from coach dashboard.
// ═══════════════════════════════════════════════════════════════════════════════

async function handleResend(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { client_id, stakeholder_id, checkpoint = 'baseline', password } = req.body || {};
    if (!client_id || !stakeholder_id) return res.status(400).json({ error: 'client_id and stakeholder_id are required' });

    const authOk = !!verifyCoachSession(req.body.session);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    // Load client
    const clientRes = await sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=id,name,email,behavior_1,start_behavior,current_sprint_number,observable_measure,organization,industry,gs_grade,project_cc_emails`);
    const clients = clientRes.ok ? await clientRes.json() : [];
    if (!clients.length) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];
    const ccCfg = await loadCcConfig();
    const priorityBehavior = (client.observable_measure || client.behavior_1 || client.start_behavior || '').trim();
    if (!priorityBehavior) return res.status(400).json({ error: 'No priority behavior on file for this client' });
    const sprintNumber = client.current_sprint_number || 1;

    // Load stakeholder
    const sRes = await sbFetch(`/rest/v1/stakeholders?id=eq.${stakeholder_id}&client_id=eq.${client_id}&select=*`);
    const stakeholders = sRes.ok ? await sRes.json() : [];
    if (!stakeholders.length) return res.status(404).json({ error: 'Stakeholder not found' });
    const stakeholder = stakeholders[0];

    // Delete any existing unused token for this stakeholder+checkpoint so we can resend fresh
    await sbFetch(
      `/rest/v1/survey_tokens?client_id=eq.${client_id}&stakeholder_id=eq.${stakeholder_id}&checkpoint=eq.${checkpoint}&is_used=eq.false`,
      'DELETE', null, { Prefer: 'return=minimal' }
    );

    // Create new token
    const token   = generateToken();
    const now     = new Date().toISOString();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const tokenInsert = await sbFetch('/rest/v1/survey_tokens', 'POST', {
      token, client_id, stakeholder_id, checkpoint,
      priority_behavior: priorityBehavior, client_first_name: (client.name || '').split(' ')[0],
      sprint_number: sprintNumber, sent_at: now, expires_at: expires, is_used: false
    }, { Prefer: 'return=minimal' });
    if (!tokenInsert.ok) return res.status(500).json({ error: 'Failed to create survey token' });

    // Send email
    const surveyLink = `${SITE_URL}/survey?t=${token}`;
    const _bl2 = require('./brand-link');
    const _html2 = _bl2.autoLinkBrand(buildSendEmailHtml(stakeholder.name, client.name, checkpoint, priorityBehavior, surveyLink), _bl2.gpsDiagnosticLink(client));
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${FROM_NAME} <${FROM_EMAIL}>`,
        to:      [stakeholder.email],
        cc:      buildCcList(ccCfg, client.email, client.project_cc_emails),
        subject: buildSendSubjectLine(client.name, checkpoint),
        html:    _html2,
        text:    htmlToText(_html2),
        reply_to: ALEX_EMAIL
      })
    });

    const emailData = await emailRes.json();
    if (emailRes.ok) {
      await logEmail({ client_id, recipient_email: stakeholder.email, recipient_name: stakeholder.name, email_type: `survey_${checkpoint}_resend`, subject: buildSendSubjectLine(client.name, checkpoint), status: 'sent', resend_id: emailData.id || null });
      return res.status(200).json({ sent: true, name: stakeholder.name, email: stakeholder.email });
    } else {
      await logEmail({ client_id, recipient_email: stakeholder.email, recipient_name: stakeholder.name, email_type: `survey_${checkpoint}_resend`, subject: buildSendSubjectLine(client.name, checkpoint), status: 'error', error_details: JSON.stringify(emailData).slice(0, 500) });
      return res.status(500).json({ error: 'Email delivery failed', detail: emailData });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: submit
// POST /api/survey?action=submit
// Body: { token, client_id, stakeholder_id, checkpoint, score, open_response, comments, comments_visible_to_client }
// ═══════════════════════════════════════════════════════════════════════════════

async function sendResponseNotifications({ client_id, stakeholder_id, checkpoint, score, comments_visible_to_client, tokenRecord }) {
  const [clientRes, stakeholderRes] = await Promise.all([
    sbFetch(`/rest/v1/clients?id=eq.${client_id}&select=name,email`),
    sbFetch(`/rest/v1/stakeholders?id=eq.${stakeholder_id}&select=name,role`)
  ]);

  const clients      = clientRes.ok      ? await clientRes.json()      : [];
  const stakeholders = stakeholderRes.ok ? await stakeholderRes.json() : [];
  const client       = clients[0];
  const stakeholder  = stakeholders[0];
  if (!client || !stakeholder) return;

  const clientFirst     = (client.name || '').split(' ')[0];
  const stakeholderName = stakeholder.name || 'A stakeholder';
  const checkpointLabel = checkpoint === 'baseline' ? 'Baseline' : checkpoint === 'day30' ? 'Day 30' : 'Day 90';

  if (client.email) {
    const clientSubject = `${stakeholderName} just completed your ${checkpointLabel} survey`;
    const clientHtml    = buildClientNotificationHtml(clientFirst, stakeholderName, checkpointLabel, score);
    await sendNotificationEmail(client.email, clientSubject, clientHtml, client_id, client.name, 'survey_response_client');
  }

  const alexSubject = `[GPS] ${clientFirst}'s ${checkpointLabel} feedback — ${stakeholderName} | ${score}/5`;
  const alexHtml    = buildAlexNotificationHtml(client.name, stakeholderName, checkpointLabel, score, stakeholder.role || '');
  await sendNotificationEmail(ALEX_EMAIL, alexSubject, alexHtml, client_id, client.name, 'survey_response_alex');
}

function buildClientNotificationHtml(clientFirst, stakeholderName, checkpointLabel, score) {
  const p = t => `<p style="color:#1B2A4A;font-size:15px;line-height:1.75;margin:0 0 14px;">${t}</p>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:36px 16px;">
    <div style="background:#1B2A4A;padding:20px 28px;border-radius:8px 8px 0 0;text-align:center;">
      <div style="color:#C9A84C;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#FFFFFF;font-size:15px;font-weight:500;opacity:0.8;">Feedback Received</div>
    </div>
    <div style="background:#FFFFFF;padding:30px 36px;border-radius:0 0 8px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
      ${p(`Hi ${clientFirst},`)}
      ${p(`<strong>${stakeholderName}</strong> just completed your ${checkpointLabel} survey.`)}
      <div style="background:#F5F6F8;border-left:3px solid #C9A84C;padding:14px 18px;margin:14px 0;border-radius:0 6px 6px 0;">
        <div style="font-size:13px;color:#6B7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">Score</div>
        <div style="font-size:28px;font-weight:700;color:#1B2A4A;">${score}<span style="font-size:16px;color:#9CA3AF;">/5</span></div>
      </div>
      ${p(`Log in to your portal to see the full picture once all responses are in.`)}
      <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 18px;" />
      <p style="color:#4B5563;font-size:13px;line-height:1.7;margin:0;">— Alex Tremble<br>GPS Leadership Solutions</p>
    </div>
  </div>
</body>
</html>`;
}

function buildAlexNotificationHtml(clientName, stakeholderName, checkpointLabel, score, stakeholderRole) {
  const scoreColor = score >= 4 ? '#16a34a' : score >= 3 ? '#d97706' : '#dc2626';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:520px;margin:24px auto;color:#1B2A4A;font-size:14px;line-height:1.7;">
  <div style="background:#1B2A4A;padding:16px 24px;border-radius:8px 8px 0 0;">
    <div style="color:#C9A84C;font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">GPS Portal — Survey Response</div>
  </div>
  <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6B7280;width:140px;">Client</td><td style="padding:6px 0;font-weight:600;">${clientName}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Stakeholder</td><td style="padding:6px 0;">${stakeholderName}${stakeholderRole ? ` <span style="color:#9CA3AF;font-size:12px;">(${stakeholderRole})</span>` : ''}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Checkpoint</td><td style="padding:6px 0;">${checkpointLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Score</td><td style="padding:6px 0;font-size:20px;font-weight:700;color:${scoreColor};">${score}<span style="font-size:13px;color:#9CA3AF;">/5</span></td></tr>
      <tr><td style="padding:6px 0;color:#6B7280;">Submitted</td><td style="padding:6px 0;">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} ET</td></tr>
    </table>
  </div>
</body>
</html>`;
}

async function sendNotificationEmail(to, subject, html, client_id, clientName, emailType) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject, html, text: htmlToText(html), reply_to: ALEX_EMAIL })
    });
    const data = await res.json();
    await logEmail({ client_id, recipient_email: to, recipient_name: clientName, email_type: emailType, subject, status: res.ok ? 'sent' : 'error', resend_id: res.ok ? (data.id || null) : null, error_details: res.ok ? null : JSON.stringify(data).slice(0, 500) });
  } catch (_) {}
}

async function handleSubmit(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, client_id, stakeholder_id, checkpoint, score, open_response, comments, comments_visible_to_client } = req.body;

    if (!token || !client_id || !stakeholder_id || !checkpoint || score == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (score < 1 || score > 5 || !Number.isInteger(score)) {
      return res.status(400).json({ error: 'Score must be an integer between 1 and 5' });
    }

    const tokenRes = await sbFetch(`/rest/v1/survey_tokens?token=eq.${encodeURIComponent(token)}&client_id=eq.${client_id}&select=*`);
    if (!tokenRes.ok) return res.status(500).json({ error: 'Token lookup failed' });
    const tokens = await tokenRes.json();
    if (!tokens || tokens.length === 0) return res.status(404).json({ error: 'Invalid survey link' });

    const tokenRecord = tokens[0];
    if (tokenRecord.is_used) return res.status(409).json({ error: 'This survey has already been submitted' });
    if (tokenRecord.expires_at && new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This survey link has expired' });
    }

    const insertRes = await sbFetch('/rest/v1/survey_responses', 'POST', {
      client_id: tokenRecord.client_id, stakeholder_id: tokenRecord.stakeholder_id, token_id: tokenRecord.id, checkpoint: tokenRecord.checkpoint, score, scale: 5,
      sprint_number: tokenRecord.sprint_number || 1,
      open_response: open_response || null,
      comments:      comments      || null,
      comments_visible_to_client: comments_visible_to_client !== false
    }, { 'Prefer': 'return=minimal' });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(500).json({ error: 'Failed to save response', detail: errText });
    }

    await sbFetch(`/rest/v1/survey_tokens?id=eq.${tokenRecord.id}`, 'PATCH',
      { is_used: true, used_at: new Date().toISOString() },
      { 'Prefer': 'return=minimal' }
    );

    sendResponseNotifications({ client_id: tokenRecord.client_id, stakeholder_id: tokenRecord.stakeholder_id, checkpoint: tokenRecord.checkpoint, score, comments_visible_to_client: comments_visible_to_client !== false, tokenRecord }).catch(() => {});

    // Auto-taper: if the behavior has scored 4+/5 across raters on two consecutive
    // pulses, cancel the remaining scheduled pulses (measurement retires once the
    // behavior is embedded). AWAITED (not fire-and-forget) so it reliably completes
    // before the serverless function can freeze after the response is sent.
    // maybeAutoTaper has its own internal try/catch, so it can never fail a submit.
    await maybeAutoTaper(client_id, tokenRecord.sprint_number || 1);

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
