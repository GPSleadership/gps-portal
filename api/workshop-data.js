// GPS Leadership — Workshop Module Coach API
//
// Coach-session-gated server logic for the Workshop Module. Ordinary CRUD on
// workshops / workshop_participants / workshop_questions / workshop_responses
// goes through the generic allowlisted proxy in api/coach-data.js. THIS file
// holds the custom logic that proxy can't express:
//   roster upload (one-profile-per-person), AI question suggestions,
//   pre→post AI questions, aggregation/indices, AI exec summary, the
//   recommendation rules engine, survey-invite + recap emails, CSV/GHL exports,
//   and the survey-reminder cron.
//
// Security: every action requires a valid coach SESSION (same HMAC scheme as
// coach-data.js), EXCEPT action=reminders which is a cron and accepts
// `Bearer CRON_SECRET` / the x-vercel-cron header (or a coach session for manual
// runs). The browser never touches Supabase; this runs as the service role.
//
// POST /api/workshop-data   { session, action, ... }
// GET|POST /api/workshop-data?action=reminders   (cron)
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET, CRON_SECRET,
//      ANTHROPIC_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL, PORTAL_BASE_URL

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const CRON_SECRET          = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const RESEND_FROM          = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE_URL      = (process.env.PORTAL_BASE_URL || process.env.SITE_URL || 'https://portal.gpsleadership.org').replace(/\/$/, '');

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_FAST  = 'claude-haiku-4-5-20251001';
const enc = encodeURIComponent;

// ── Coach session verification (same HMAC scheme as coach-data.js) ───────────
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

// ── Supabase service-role helpers ────────────────────────────────────────────
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
async function sbGet(path) {
  const r = await sb(path);
  if (!r.ok) return [];
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}
async function sbOne(path) { const rows = await sbGet(path); return rows[0] || null; }

// ── Small utilities ──────────────────────────────────────────────────────────
function avg(nums) {
  const v = (nums || []).filter(s => s != null && !isNaN(s)).map(Number);
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
}
function round2(x) { return x == null ? null : Math.round(Number(x) * 100) / 100; }
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
function isoNow() { return new Date().toISOString(); }

// TP3 themes → index buckets.
const TP3_THEMES = { trust: 'trust', proactivity: 'proactivity', productivity: 'productivity' };

// ── Email via Resend (self-contained, like diagnostic.js) ────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`, to: [to], subject, html }),
    });
    const data = await r.json().catch(() => ({}));
    // Best-effort email log (table exists; ignore failures).
    sb('/rest/v1/email_log', 'POST', {
      sent_at: isoNow(), recipient_email: to, email_type: subject.slice(0, 60),
      status: r.ok ? 'sent' : 'error', error_details: r.ok ? null : JSON.stringify(data), resend_id: data.id || null,
    }, { Prefer: 'return=minimal' }).catch(() => {});
    return { ok: r.ok, id: data.id, error: r.ok ? null : (data.message || 'send failed') };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Anthropic call → returns text ────────────────────────────────────────────
async function claude(model, system, userText, maxTokens = 1200) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userText }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || 'Claude error');
  return (data.content || []).map(c => c.text || '').join('').trim();
}
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ── Aggregation: indices, deltas, participation, NPS ─────────────────────────
async function aggregate(workshopId) {
  const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(workshopId)}&select=id,pre_status,post_status`);
  const resp  = await sbGet(`/rest/v1/workshop_responses?workshop_id=eq.${enc(workshopId)}&select=phase,question_theme,question_id,response_value,response_text`);

  const total = parts.length;
  const preDone  = parts.filter(p => p.pre_status === 'complete').length;
  const postDone = parts.filter(p => p.post_status === 'complete').length;

  // Per-theme averages by phase (numeric/scale only).
  const themesByPhase = { pre: {}, post: {} };
  const npsRaw = { pre: [], post: [] };
  const verbatims = { pre: [], post: [] };
  for (const r of resp) {
    const ph = r.phase === 'post' ? 'post' : (r.phase === 'pre' ? 'pre' : null);
    if (!ph) continue;
    if (r.response_value != null && !isNaN(r.response_value)) {
      if (String(r.question_id).startsWith('NPS')) { npsRaw[ph].push(Number(r.response_value)); continue; }
      const t = r.question_theme || 'other';
      (themesByPhase[ph][t] = themesByPhase[ph][t] || []).push(Number(r.response_value));
    } else if (r.response_text) {
      verbatims[ph].push({ theme: r.question_theme || 'open', text: r.response_text });
    }
  }
  const themeAvg = ph => Object.fromEntries(Object.entries(themesByPhase[ph]).map(([t, a]) => [t, avg(a)]));
  const preThemes  = themeAvg('pre');
  const postThemes = themeAvg('post');

  const tp3 = {};
  for (const t of Object.keys(TP3_THEMES)) {
    const pre = preThemes[t] ?? null, post = postThemes[t] ?? null;
    tp3[t] = { pre, post, delta: (pre != null && post != null) ? round2(post - pre) : null };
  }

  // Participant NPS: prefer post, fall back to pre. Proper NPS = %prom - %detr.
  const npsScores = npsRaw.post.length ? npsRaw.post : npsRaw.pre;
  let nps = null, npsAvg = null;
  if (npsScores.length) {
    const prom = npsScores.filter(s => s >= 9).length;
    const detr = npsScores.filter(s => s <= 6).length;
    nps = Math.round(((prom - detr) / npsScores.length) * 100);
    npsAvg = avg(npsScores);
  }

  // All themes (incl. delegation/meetings/communication/satisfaction) for the grid.
  const allThemes = Array.from(new Set([...Object.keys(preThemes), ...Object.keys(postThemes)]));
  const themeTable = allThemes.map(t => ({
    theme: t, pre: preThemes[t] ?? null, post: postThemes[t] ?? null,
    delta: (preThemes[t] != null && postThemes[t] != null) ? round2(postThemes[t] - preThemes[t]) : null,
  }));

  return {
    participation: {
      total,
      pre:  { done: preDone,  rate: total ? Math.round((preDone / total) * 100) : 0 },
      post: { done: postDone, rate: total ? Math.round((postDone / total) * 100) : 0 },
    },
    tp3, themeTable, nps, npsAvg,
    verbatims,
  };
}

// ── Recommendation rules engine (server-side, GPS-aligned framing) ───────────
// Frames every suggestion as "the fastest way to fix what the data shows."
function recommendFrom(agg, workshop) {
  const fired = [];
  const t = agg.tp3 || {};
  const trust = t.trust?.post ?? t.trust?.pre;
  const proact = t.proactivity?.post ?? t.proactivity?.pre;
  const prod = t.productivity?.post ?? t.productivity?.pre;
  const deleg = (agg.themeTable.find(x => x.theme === 'delegation') || {});
  const delegVal = deleg.post ?? deleg.pre;
  const nps = agg.nps;

  let primary = null;
  // Trust / leadership perception gaps → 14-Day Executive Diagnostic.
  if (trust != null && trust < 3.5) {
    primary = {
      step: '14-Day Executive Leadership Diagnostic',
      headline: 'The fastest way to fix the trust pattern the data shows',
      rationale: `Team trust is reading ${trust}/5 — low enough that it is quietly slowing execution. A 14-Day Executive Leadership Diagnostic surfaces exactly where the perception gaps are between the leader and the team, so the fix is targeted instead of guessed at.`,
    };
    fired.push('trust<3.5 → diagnostic');
  }
  // Strong CEO bottleneck pattern (low delegation/proactivity) → 90-Day CEO Reset.
  if (!primary && ((delegVal != null && delegVal < 3.5) || (proact != null && proact < 3.5))) {
    primary = {
      step: '90-Day CEO Reset',
      headline: 'The fastest way to get decisions off your desk',
      rationale: `Decisions are bottlenecking and ownership is reading low (delegation ${delegVal ?? 'n/a'}/5, proactivity ${proact ?? 'n/a'}/5). A 90-Day CEO Reset installs the operating habits that move decisions to the right level so the company stops waiting on you.`,
    };
    fired.push('delegation/proactivity<3.5 → CEO reset');
  }
  // Broad alignment/operating-system issues across themes → Executive Retreat.
  const weakThemes = agg.themeTable.filter(x => (x.post ?? x.pre) != null && (x.post ?? x.pre) < 3.5).length;
  if (!primary && weakThemes >= 3) {
    primary = {
      step: 'Executive Retreat',
      headline: 'The fastest way to get the team operating from one playbook',
      rationale: `Several areas are reading below the line at once — a sign the team is missing a shared operating system, not just one habit. A focused executive retreat aligns the team on how they make decisions and run the business together.`,
    };
    fired.push('3+ weak themes → retreat');
  }
  // Healthy result with a satisfied sponsor → reinforce + diagnostic as the next lever.
  if (!primary) {
    primary = {
      step: '14-Day Executive Leadership Diagnostic',
      headline: 'The cleanest next step to turn momentum into a system',
      rationale: `The workshop landed well${nps != null ? ` (NPS ${nps})` : ''}. A 14-Day Executive Leadership Diagnostic is the cleanest way to convert that momentum into a measurable, leader-level plan before the energy fades.`,
    };
    fired.push('default → diagnostic');
  }
  return { primary, rules_fired: fired, computed_at: isoNow() };
}

// ── Findings tied to themes (plain-language, for the sponsor dashboard) ───────
function findingsFrom(agg) {
  const strengths = [], risks = [];
  const label = { trust: 'Trust', proactivity: 'Proactivity / ownership', productivity: 'Productivity / focus',
    delegation: 'Delegation', meetings: 'Meeting effectiveness', communication: 'Communication', satisfaction: 'Satisfaction' };
  for (const row of agg.themeTable) {
    const v = row.post ?? row.pre;
    if (v == null) continue;
    const name = label[row.theme] || row.theme;
    if (v >= 4.0) strengths.push(`${name} is a strength (${v}/5).`);
    else if (v < 3.0) risks.push(`${name} is a risk (${v}/5) and is likely costing time day to day.`);
  }
  return { strengths: strengths.slice(0, 4), risks: risks.slice(0, 4) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-cron');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body   = req.body || {};
  const action = (req.query && req.query.action) || body.action;

  try {
    // ── CRON: survey reminders (no coach session required) ───────────────────
    if (action === 'reminders') {
      const authHeader = req.headers['authorization'] || '';
      const isCron = (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) || !!req.headers['x-vercel-cron'];
      const isManual = req.method === 'POST' && !!verifyCoachSession(body.session);
      if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
      const out = await runReminders();
      return res.status(200).json({ ok: true, ...out });
    }

    // ── Everything else requires a coach session ─────────────────────────────
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!verifyCoachSession(body.session)) return res.status(401).json({ error: 'Coach session invalid or expired' });

    switch (action) {

      // Upload roster → one profile per person (reuse clients by email) ────────
      case 'upload-roster': {
        const workshopId = body.workshop_id;
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (!workshopId || !rows.length) return res.status(400).json({ error: 'workshop_id and rows required' });
        let created = 0, linked = 0, skipped = 0;
        for (const raw of rows) {
          const name  = (raw.name || '').trim();
          const email = (raw.email || '').trim().toLowerCase();
          if (!email || !name) { skipped++; continue; }
          // One profile per person: find existing client by email first.
          let client = await sbOne(`/rest/v1/clients?email=eq.${enc(email)}&select=id&limit=1`);
          if (!client) {
            const ins = await sb('/rest/v1/clients', 'POST', {
              name, email, title: raw.role || null, organization: raw.org || null,
              is_workshop_participant: true, in_coaching_program: false, is_active: true,
            }, { Prefer: 'return=representation' });
            const cr = await ins.json().catch(() => []);
            client = Array.isArray(cr) ? cr[0] : cr;
            if (!client?.id) { skipped++; continue; }
            created++;
          }
          // Link to workshop (idempotent on workshop_id+client_id).
          const link = await sb('/rest/v1/workshop_participants?on_conflict=workshop_id,client_id', 'POST', {
            workshop_id: workshopId, client_id: client.id,
            role: raw.role || null, location: raw.location || null, department: raw.department || null,
          }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
          if (link.ok) linked++; else skipped++;
        }
        return res.status(200).json({ ok: true, created, linked, skipped });
      }

      // AI: suggest 2-3 PRE questions from discovery notes/transcript ──────────
      case 'suggest-questions': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const ctx = `Workshop: ${w.title}\nOrg: ${w.client_org_name || ''}\nIndustry: ${w.industry || ''}\nAudience: ${w.audience_level || ''}\n\nDiscovery notes / transcript:\n${(w.discovery_transcript || w.discovery_notes || '(none provided)').slice(0, 8000)}`;
        const sys = 'You are helping design a short pre-workshop leadership survey for an operations-heavy company. Propose 2-3 additional 1-5 scale questions specific to THIS team based on the discovery context. Each must map to a theme (trust, proactivity, productivity, delegation, meetings, communication). Return ONLY JSON: [{"question_id":"CUSTOM_1","question_theme":"...","question_text":"...","response_type":"scale"}]. Keep questions concrete and answerable on a 1-5 agreement scale.';
        const text = await claude(CLAUDE_FAST, sys, ctx, 700);
        const arr = parseJsonLoose(text);
        if (!Array.isArray(arr)) return res.status(200).json({ ok: true, suggestions: [], raw: text });
        // Insert as draft, source=ai_suggested — coach approves before they go live.
        const toInsert = arr.slice(0, 3).map((q, i) => ({
          workshop_id: body.workshop_id, question_id: q.question_id || `AI_PRE_${Date.now()}_${i}`,
          question_theme: q.question_theme || 'other', phase: 'pre', question_text: q.question_text,
          response_type: q.response_type === 'text' ? 'text' : 'scale', scale_min: 1, scale_max: 5,
          source: 'ai_suggested', status: 'draft', sort_order: 200 + i,
        })).filter(q => q.question_text);
        if (toInsert.length) await sb('/rest/v1/workshop_questions', 'POST', toInsert, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, suggestions: toInsert });
      }

      // AI: suggest 2-3 POST questions from pre-survey patterns ────────────────
      case 'generate-post-questions': {
        const agg = await aggregate(body.workshop_id);
        const sys = 'You design 2-3 post-workshop survey questions that check whether the shifts we hoped to see actually happened, based on the pre-workshop data. Return ONLY JSON: [{"question_id":"POSTCHK_1","question_theme":"...","question_text":"...","response_type":"scale"}]. Frame as "since the workshop, ..." on a 1-5 scale.';
        const ctx = `Pre-workshop theme averages (1-5): ${JSON.stringify(agg.themeTable)}\nTP3: ${JSON.stringify(agg.tp3)}`;
        const text = await claude(CLAUDE_FAST, sys, ctx, 700);
        const arr = parseJsonLoose(text);
        if (!Array.isArray(arr)) return res.status(200).json({ ok: true, suggestions: [], raw: text });
        const toInsert = arr.slice(0, 3).map((q, i) => ({
          workshop_id: body.workshop_id, question_id: q.question_id || `AI_POST_${Date.now()}_${i}`,
          question_theme: q.question_theme || 'other', phase: 'post', question_text: q.question_text,
          response_type: q.response_type === 'text' ? 'text' : 'scale', scale_min: 1, scale_max: 5,
          source: 'ai_suggested', status: 'draft', sort_order: 200 + i,
        })).filter(q => q.question_text);
        if (toInsert.length) await sb('/rest/v1/workshop_questions', 'POST', toInsert, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, suggestions: toInsert });
      }

      // Aggregate indices/deltas (used by dashboard + summary + recommend) ─────
      case 'aggregate': {
        const agg = await aggregate(body.workshop_id);
        return res.status(200).json({ ok: true, aggregate: agg });
      }

      // AI exec summary (3 bullets) → stores exec_summary_json ─────────────────
      case 'generate-summary': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        const agg = await aggregate(body.workshop_id);
        const findings = findingsFrom(agg);
        let focus90 = [];
        try {
          const sys = 'You are Alex Tremble, a leadership operator. From the workshop data, write the recommended 90-day focus as 2-3 short, concrete bullets a CEO can act on. Plain language, no theory. Return ONLY JSON: {"focus90":["...","..."]}.';
          const ctx = `Themes (1-5): ${JSON.stringify(agg.themeTable)}\nParticipation: ${JSON.stringify(agg.participation)}\nNPS: ${agg.nps}`;
          const parsed = parseJsonLoose(await claude(CLAUDE_MODEL, sys, ctx, 500));
          if (parsed && Array.isArray(parsed.focus90)) focus90 = parsed.focus90.slice(0, 3);
        } catch (e) { /* non-fatal; summary still stored with rule-based findings */ }
        const summary = {
          participation: agg.participation, nps: agg.nps, npsAvg: agg.npsAvg, tp3: agg.tp3,
          strengths: findings.strengths, risks: findings.risks, focus90, computed_at: isoNow(),
        };
        await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH',
          { exec_summary_json: summary, updated_at: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, exec_summary: summary });
      }

      // Recommendation rules engine → stores recommendation_json ───────────────
      case 'recommend': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        const agg = await aggregate(body.workshop_id);
        const rec = recommendFrom(agg, w);
        await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH',
          { recommendation_json: rec, updated_at: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, recommendation: rec });
      }

      // Send survey invites (pre or post) to participants ──────────────────────
      case 'send-invites': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(body.workshop_id)}&select=id,participant_token,client_id`);
        let sent = 0;
        for (const p of parts) {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
          if (!c?.email) continue;
          const url = `${PORTAL_BASE_URL}/workshop-survey?token=${enc(p.participant_token)}&phase=${phase}`;
          const subj = phase === 'pre'
            ? `Quick pre-work before the ${w.title} workshop (5-7 min)`
            : `Your follow-up survey for the ${w.title} workshop (5 min)`;
          const html = inviteHtml(c.name, w, phase, url);
          const r = await sendEmail(c.email, subj, html);
          if (r.ok) { sent++; await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH', { invited_at: isoNow() }, { Prefer: 'return=minimal' }); }
        }
        // Use existing open timestamp if already set — don't overwrite the audit trail.
        const patch = { updated_at: isoNow() };
        if (phase === 'pre')  { patch.pre_survey_open_at  = w.pre_survey_open_at  || isoNow(); patch.status = 'pre_survey_open'; }
        else                  { patch.post_survey_open_at = w.post_survey_open_at || isoNow(); patch.status = 'post_survey_open'; }
        await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH', patch, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, sent, total: parts.length });
      }

      // Post-debrief recap email to the sponsor ────────────────────────────────
      case 'send-recap': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const sponsor = w.sponsor_client_id ? await sbOne(`/rest/v1/clients?id=eq.${enc(w.sponsor_client_id)}&select=name,email&limit=1`) : null;
        const to = body.to || sponsor?.email;
        if (!to) return res.status(400).json({ error: 'No sponsor email on file' });
        const agg = await aggregate(body.workshop_id);
        const findings = findingsFrom(agg);
        const rec = w.recommendation_json || recommendFrom(agg, w);
        const html = recapHtml(sponsor?.name || 'there', w, agg, findings, rec);
        const subj = `Recap & next steps — ${w.title}`;
        const r = await sendEmail(to, subj, html);
        if (r.ok) await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH', { recap_sent_at: isoNow(), updated_at: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: r.ok, error: r.error });
      }

      // Participant-level CSV export (deep analysis / AI training) ──────────────
      case 'export-participant-csv': {
        const resp = await sbGet(`/rest/v1/workshop_responses?workshop_id=eq.${enc(body.workshop_id)}&select=participant_id,phase,question_id,question_text,question_theme,response_value,response_text,created_at&order=created_at.asc`);
        const header = ['participant_id', 'phase', 'question_id', 'question_text', 'question_theme', 'response_value', 'response_text', 'created_at'];
        const out = csv([header, ...resp.map(r => [r.participant_id, r.phase, r.question_id, r.question_text, r.question_theme, r.response_value, r.response_text, r.created_at])]);
        return res.status(200).json({ ok: true, filename: `workshop_${body.workshop_id}_participant_responses.csv`, csv: out });
      }

      // Sponsor-summary CSV (workshop-level aggregates + GHL KPIs) ──────────────
      case 'export-sponsor-csv': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        const agg = await aggregate(body.workshop_id);
        const rec = w.recommendation_json || recommendFrom(agg, w);
        const fit = recToFit(rec);
        const header = ['metric', 'value'];
        const rows = [
          header,
          ['Workshop Title', w.title], ['Organization', w.client_org_name], ['Workshop Date', w.workshop_date],
          ['Industry', w.industry], ['Audience Level', w.audience_level],
          ['Participants', agg.participation.total],
          ['Pre Response Rate %', agg.participation.pre.rate], ['Post Response Rate %', agg.participation.post.rate],
          ['Workshop NPS', agg.nps], ['Avg Satisfaction (0-10)', agg.npsAvg],
          ['Trust Index (pre)', agg.tp3.trust?.pre], ['Trust Index (post)', agg.tp3.trust?.post],
          ['Proactivity Index (pre)', agg.tp3.proactivity?.pre], ['Proactivity Index (post)', agg.tp3.proactivity?.post],
          ['Productivity Index (pre)', agg.tp3.productivity?.pre], ['Productivity Index (post)', agg.tp3.productivity?.post],
          ['Recommended Next Step', rec.primary?.step], ['Diagnostic Fit', fit],
        ];
        return res.status(200).json({ ok: true, filename: `workshop_${body.workshop_id}_sponsor_summary.csv`, csv: csv(rows) });
      }

      // GHL field map (single-row CSV of the KPI fields that sync to GoHighLevel)
      case 'ghl-export': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        const agg = await aggregate(body.workshop_id);
        const rec = w.recommendation_json || recommendFrom(agg, w);
        const sponsor = w.sponsor_client_id ? await sbOne(`/rest/v1/clients?id=eq.${enc(w.sponsor_client_id)}&select=name,email,organization&limit=1`) : {};
        const map = {
          'Sponsor Name': sponsor?.name || '', 'Sponsor Email': sponsor?.email || '',
          'Last Workshop Date': w.workshop_date || '', 'Workshop Industry': w.industry || '',
          'Workshop Audience Level': w.audience_level || '',
          'Last Workshop NPS': agg.nps ?? '', 'Last Workshop Trust Index': agg.tp3.trust?.post ?? agg.tp3.trust?.pre ?? '',
          'Last Workshop Proactivity Index': agg.tp3.proactivity?.post ?? agg.tp3.proactivity?.pre ?? '',
          'Diagnostic Fit (yes/no/maybe)': recToFit(rec),
        };
        const header = Object.keys(map);
        return res.status(200).json({ ok: true, filename: `workshop_${body.workshop_id}_ghl.csv`, csv: csv([header, header.map(k => map[k])]), fields: map });
      }

      // ── Organization management (v40) ─────────────────────────────────────

      // List all organizations (optionally filtered by name search)
      case 'org-list': {
        const q = body.search ? `&name=ilike.${enc('%' + body.search + '%')}` : '';
        const orgs = await sbGet(`/rest/v1/organizations?order=name.asc&limit=200${q}`);
        return res.status(200).json({ ok: true, organizations: orgs });
      }

      // Create a new organization
      case 'org-create': {
        const name = (body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'name required' });
        const r = await sb('/rest/v1/organizations', 'POST', {
          name, industry: body.industry || null, size_band: body.size_band || null,
          tags: Array.isArray(body.tags) ? body.tags : [],
          logo_url: body.logo_url || null, notes: body.notes || null,
          created_at: isoNow(), updated_at: isoNow(),
        }, { Prefer: 'return=representation' });
        const rows = await r.json().catch(() => []);
        const org = Array.isArray(rows) ? rows[0] : rows;
        return res.status(200).json({ ok: true, organization: org });
      }

      // Update an existing organization
      case 'org-update': {
        const id = body.org_id;
        if (!id) return res.status(400).json({ error: 'org_id required' });
        const patch = { updated_at: isoNow() };
        if (body.name      != null) patch.name      = body.name;
        if (body.industry  != null) patch.industry  = body.industry;
        if (body.size_band != null) patch.size_band = body.size_band;
        if (body.tags      != null) patch.tags      = body.tags;
        if (body.logo_url  != null) patch.logo_url  = body.logo_url;
        if (body.notes     != null) patch.notes     = body.notes;
        await sb(`/rest/v1/organizations?id=eq.${enc(id)}`, 'PATCH', patch, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── TP3 Assessment creation (v40) — creates workshop + seeds 21 Qs ───────

      case 'create-assessment': {
        const title = (body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'title required' });

        // 1. Resolve or create organization
        let orgId = body.org_id || null;
        let orgLogoUrl = null;
        if (!orgId && body.org_name) {
          // Try to find by name (case-insensitive)
          const existing = await sbOne(`/rest/v1/organizations?name=ilike.${enc(body.org_name)}&select=id,logo_url&limit=1`);
          if (existing) {
            orgId = existing.id;
            orgLogoUrl = existing.logo_url;
          } else {
            // Create new org
            const r = await sb('/rest/v1/organizations', 'POST', {
              name: body.org_name, industry: body.industry || null,
              size_band: body.size_band || null, tags: body.tags || [],
              created_at: isoNow(), updated_at: isoNow(),
            }, { Prefer: 'return=representation' });
            const rows = await r.json().catch(() => []);
            const org = Array.isArray(rows) ? rows[0] : rows;
            orgId = org?.id || null;
          }
        }

        // 2. Handle logo upload (base64 data URL → Supabase Storage)
        if (body.logo_data_url && orgId) {
          try {
            const match = body.logo_data_url.match(/^data:([a-zA-Z/]+);base64,(.+)$/);
            if (match) {
              const mime = match[1];
              const buf  = Buffer.from(match[2], 'base64');
              const ext  = mime.includes('png') ? 'png' : 'jpg';
              const path = `org-logos/${orgId}.${ext}`;
              const up = await fetch(`${SUPABASE_URL}/storage/v1/object/org-assets/${path}`, {
                method: 'POST',
                headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': mime, 'x-upsert': 'true' },
                body: buf,
              });
              if (up.ok) {
                orgLogoUrl = `${SUPABASE_URL}/storage/v1/object/public/org-assets/${path}`;
                await sb(`/rest/v1/organizations?id=eq.${enc(orgId)}`, 'PATCH', { logo_url: orgLogoUrl, updated_at: isoNow() }, { Prefer: 'return=minimal' });
              }
            }
          } catch (_) { /* logo upload is non-fatal */ }
        }

        // 3. Resolve or create sponsor client
        let sponsorId = null;
        const spEmail = (body.sponsor_email || '').toLowerCase().trim();
        const spName  = (body.sponsor_name  || '').trim();
        const spTitle = (body.sponsor_title || '').trim() || null;
        if (spEmail) {
          const ex = await sbOne(`/rest/v1/clients?email=eq.${enc(spEmail)}&select=id&limit=1`);
          if (ex) {
            sponsorId = ex.id;
            // Update title if provided and not already set
            if (spTitle) {
              await sb(`/rest/v1/clients?id=eq.${enc(ex.id)}`, 'PATCH', { title: spTitle }, { Prefer: 'return=minimal' });
            }
          } else {
            const r = await sb('/rest/v1/clients', 'POST', {
              name: spName || spEmail, email: spEmail, title: spTitle,
              organization: body.org_name || null,
              token: crypto.randomUUID(),
              in_coaching_program: false, is_active: true,
            }, { Prefer: 'return=representation' });
            const rows = await r.json().catch(() => []);
            const c = Array.isArray(rows) ? rows[0] : rows;
            sponsorId = c?.id || null;
          }
        }

        // 4. Create the workshop record
        const wr = await sb('/rest/v1/workshops', 'POST', {
          title,
          engagement_kind: 'assessment',
          client_org_name: body.org_name || null,
          organization_id: orgId,
          debrief_date: body.debrief_date || null,
          sponsor_client_id: sponsorId,
          industry: body.industry || null,
          company_size_band: body.size_band || null,
          audience_level: body.audience_level || null,
          tags: body.tags || [],
          status: 'setup',
          is_demo: body.is_demo === true,
          is_archived: false,
        }, { Prefer: 'return=representation' });
        const wrows = await wr.json().catch(() => []);
        const w = Array.isArray(wrows) ? wrows[0] : wrows;
        if (!w?.id) return res.status(500).json({ error: 'Failed to create workshop record' });

        // 5. Seed per-assessment copies of the 21 TP3 base questions
        const templates = await sbGet(`/rest/v1/workshop_questions?workshop_id=is.null&template_set=eq.tp3_assessment&is_demographic=eq.false&order=sort_order.asc`);
        if (templates.length) {
          const seeded = templates.map(t => ({
            workshop_id:    w.id,
            question_id:    t.question_id,
            question_theme: t.question_theme,
            question_text:  t.question_text,
            response_type:  t.response_type,
            scale_min:      t.scale_min,
            scale_max:      t.scale_max,
            choice_options: t.choice_options,
            template_set:   'tp3_assessment',
            source:         'standard',
            status:         'approved',
            sort_order:     t.sort_order,
            phase:          t.phase || 'pre',
          }));
          await sb('/rest/v1/workshop_questions', 'POST', seeded, { Prefer: 'return=minimal' });
        }

        return res.status(200).json({ ok: true, workshop_id: w.id, org_id: orgId, org_logo_url: orgLogoUrl });
      }

      // ── Enhanced AI question suggest (v40) — requires discovery context ───────

      case 'suggest-questions-v2': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });

        // Pull org context if linked
        let orgCtx = '';
        if (w.organization_id) {
          const org = await sbOne(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=name,industry,size_band,notes&limit=1`);
          if (org) orgCtx = `Organization: ${org.name}\nIndustry: ${org.industry || ''}\nSize: ${org.size_band || ''}\nOrg notes: ${org.notes || ''}`;
        }
        const discovery = (w.discovery_transcript || w.discovery_notes || '(no discovery notes)').slice(0, 10000);
        const ctx = `${orgCtx}\nWorkshop: ${w.title}\nAudience level: ${w.audience_level || ''}\nDiscovery notes:\n${discovery}`;
        const sys = 'You are helping design a TP3 Organizational Assessment survey for an operations-heavy company. The base 21 questions cover trust/proactivity/productivity/NPS/qualitative/bottleneck — those are already included. Your job: propose 5-6 ADDITIONAL client-specific questions based on the discovery context. The mix MUST include: at least 2 additional scale questions (1-5, map to trust/proactivity/productivity), and at least 2 qualitative behavior-focused questions (start with "Describe a recent situation where..." or similar). Return ONLY JSON array: [{"question_id":"AI_V2_1","question_theme":"trust","question_text":"...","response_type":"scale"},{"question_id":"AI_V2_2","question_theme":"qualitative","question_text":"Describe a recent situation where...","response_type":"text"}]. No explanation outside the JSON.';
        const text = await claude(CLAUDE_MODEL, sys, ctx, 1200);
        const arr = parseJsonLoose(text);
        if (!Array.isArray(arr)) return res.status(200).json({ ok: true, suggestions: [], raw: text });
        const toInsert = arr.slice(0, 6).map((q, i) => ({
          workshop_id:    body.workshop_id,
          question_id:    q.question_id || `AI_V2_${Date.now()}_${i}`,
          question_theme: q.question_theme || 'custom',
          template_set:   'tp3_assessment',
          phase:          'pre',
          question_text:  q.question_text,
          response_type:  q.response_type === 'text' ? 'text' : 'scale',
          scale_min:      q.response_type === 'text' ? null : 1,
          scale_max:      q.response_type === 'text' ? null : 5,
          source:         'ai_suggested',
          status:         'draft',
          sort_order:     250 + i,
        })).filter(q => q.question_text);
        if (toInsert.length) await sb('/rest/v1/workshop_questions', 'POST', toInsert, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, suggestions: toInsert });
      }

      // ── Draft recap email using AI ────────────────────────────────────────────

      case 'draft-recap-email': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const agg = await aggregate(body.workshop_id);
        const findings = findingsFrom(agg);
        const sum = w.exec_summary_json || {};
        const rec = w.recommendation_json || recommendFrom(agg, w);
        const spLink = `${PORTAL_BASE_URL}/workshop-room?token=${enc(w.sponsor_token || '')}`;

        const ctx = [
          `Assessment: ${w.title}`,
          `Organization: ${w.client_org_name || ''}`,
          `Debrief date: ${w.debrief_date || ''}`,
          `TP3 — Trust: ${agg.tp3?.trust?.pre ?? '—'}, Proactivity: ${agg.tp3?.proactivity?.pre ?? '—'}, Productivity: ${agg.tp3?.productivity?.pre ?? '—'}`,
          `NPS: ${agg.nps ?? '—'} | Response rate: ${agg.participation?.pre?.rate ?? '—'}%`,
          `Participants: ${agg.participation?.total ?? 0}`,
          `Strengths: ${(sum.strengths || findings.strengths).join('; ')}`,
          `Risks: ${(sum.risks || findings.risks).join('; ')}`,
          `90-day focus: ${(sum.focus90 || []).join('; ')}`,
          `Recommended next step: ${rec?.primary?.step || ''} — ${rec?.primary?.headline || ''}`,
          `Discovery notes (excerpt): ${(w.discovery_transcript || w.discovery_notes || '').slice(0, 3000)}`,
          `Sponsor dashboard: ${spLink}`,
        ].join('\n');

        const sys = `You are Alex Tremble, a leadership operator at GPS Leadership Solutions. Write a post-debrief recap email to the sponsor. Tone: direct, warm, no hype. Structure: (1) short thank-you and reference to the debrief conversation, (2) key metrics table (TP3 scores, NPS, response rate), (3) 2-3 top strengths as bullets, (4) 2-3 top risks as bullets, (5) agreed 90-day focus as bullets, (6) sponsor dashboard link, (7) CTA for the 14-Day Executive Leadership Diagnostic. Use plain HTML formatting. Return ONLY the email body HTML — no subject line, no outer envelope.`;
        const html = await claude(CLAUDE_MODEL, sys, ctx, 2000);

        // Store draft in the workshop record
        await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH',
          { recap_email_draft: html, updated_at: isoNow() }, { Prefer: 'return=minimal' });

        return res.status(200).json({ ok: true, draft_html: html });
      }

      // ── Send survey emails individually (assessment version) ─────────────────
      // Sends to participants where invited_at IS NULL (not yet sent).

      case 'send-survey-emails': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const allParts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(body.workshop_id)}&select=id,participant_token,client_id,invited_at`);
        // Filter to only not-yet-invited (allow force_all flag for resend-all)
        const parts = body.force_all ? allParts : allParts.filter(p => !p.invited_at);
        let sent = 0;
        for (const p of parts) {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
          if (!c?.email) continue;
          const url = `${PORTAL_BASE_URL}/workshop-survey?token=${enc(p.participant_token)}&phase=pre`;
          const subj = `Your ${w.title} survey — 5–10 minutes, completely confidential`;
          const html = inviteHtml(c.name, w, 'pre', url);
          const r = await sendEmail(c.email, subj, html);
          if (r.ok) {
            sent++;
            await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH',
              { invited_at: isoNow() }, { Prefer: 'return=minimal' });
          }
        }
        // Advance status if first send
        if (sent > 0 && !w.pre_survey_open_at) {
          await sb(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}`, 'PATCH',
            { pre_survey_open_at: isoNow(), status: 'pre_survey_open', updated_at: isoNow() },
            { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, sent, total: parts.length, skipped: parts.length - sent });
      }

      // ── Resend survey to one participant ──────────────────────────────────────

      case 'resend-survey-email': {
        const participantId = body.participant_id;
        if (!participantId) return res.status(400).json({ error: 'participant_id required' });
        const p = await sbOne(`/rest/v1/workshop_participants?id=eq.${enc(participantId)}&select=*&limit=1`);
        if (!p) return res.status(404).json({ error: 'Participant not found' });
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(p.workshop_id)}&select=*&limit=1`);
        const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
        if (!c?.email) return res.status(400).json({ error: 'No email on file for this participant' });
        const phase = (w && w.status === 'post_survey_open') ? 'post' : 'pre';
        const url = `${PORTAL_BASE_URL}/workshop-survey?token=${enc(p.participant_token)}&phase=${phase}`;
        const subj = `Reminder: ${w.title} survey — still need your input`;
        const html = reminderHtml(c.name, w, phase, url, 'is still open');
        const r = await sendEmail(c.email, subj, html);
        if (r.ok) {
          await sb(`/rest/v1/workshop_participants?id=eq.${enc(participantId)}`, 'PATCH',
            { invited_at: p.invited_at || isoNow(), last_reminder_at: isoNow() },
            { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: r.ok, error: r.error });
      }

      // ── Archive engagement ────────────────────────────────────────────────────

      case 'archive-engagement': {
        const id = body.workshop_id;
        if (!id) return res.status(400).json({ error: 'workshop_id required' });
        await sb(`/rest/v1/workshops?id=eq.${enc(id)}`, 'PATCH',
          { is_archived: true, updated_at: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Permanently delete engagement and all related data ────────────────────

      case 'delete-engagement': {
        const id = body.workshop_id;
        if (!id) return res.status(400).json({ error: 'workshop_id required' });
        // Cascade: responses → participants → questions → workshop
        await sb(`/rest/v1/workshop_responses?workshop_id=eq.${enc(id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        await sb(`/rest/v1/workshop_participants?workshop_id=eq.${enc(id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        await sb(`/rest/v1/workshop_questions?workshop_id=eq.${enc(id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        await sb(`/rest/v1/workshops?id=eq.${enc(id)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Generate demo data (is_demo assessments only) ─────────────────────────

      case 'generate-demo-data': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        if (!w.is_demo) return res.status(403).json({ error: 'generate-demo-data is only allowed on is_demo assessments' });

        const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(body.workshop_id)}&select=id,client_id`);
        if (!parts.length) return res.status(400).json({ error: 'Upload a roster first — need participants to generate data for.' });
        const qs = await sbGet(`/rest/v1/workshop_questions?workshop_id=eq.${enc(body.workshop_id)}&status=eq.approved&order=sort_order.asc`);
        if (!qs.length) return res.status(400).json({ error: 'No approved questions found.' });

        // Wipe existing responses for this workshop
        await sb(`/rest/v1/workshop_responses?workshop_id=eq.${enc(body.workshop_id)}`, 'DELETE', null, { Prefer: 'return=minimal' });

        const qualPool = [
          'We need to get better at communicating decisions earlier.',
          'The team is strong but gets bogged down in approval loops.',
          'More ownership at the manager level would unlock a lot.',
          'Meetings are too long and rarely end with clear next steps.',
          'Cross-department trust is lower than it should be.',
          'Leaders say the right things but follow-through is inconsistent.',
          'The best thing we do is stay close to the customer.',
          'Execution slows down every time priorities shift.',
        ];
        const pick = arr => arr[Math.floor(Math.random() * arr.length)];
        const scaleVal = (bias) => Math.min(5, Math.max(1, Math.round(bias + (Math.random() * 1.2 - 0.6))));
        const choiceOpts = ['Trust (how much we can rely on each other and our leaders)', 'Proactivity (ownership, raising issues early, taking initiative)', 'Productivity (clarity, meetings, and how fast work actually moves)', "They're roughly equal"];

        const rows = [];
        for (const p of parts) {
          // Bias per participant (simulate realistic spread)
          const bias = 2.8 + Math.random() * 1.6;
          for (const q of qs) {
            if (q.is_demographic) continue;
            let rv = null, rt = null;
            if (q.response_type === 'scale') {
              rv = scaleVal(bias);
            } else if (q.response_type === 'numeric') {
              // NPS
              rv = Math.round(4 + Math.random() * 6);
            } else if (q.response_type === 'choice') {
              rt = pick(choiceOpts);
            } else {
              rt = pick(qualPool);
            }
            rows.push({
              workshop_id: body.workshop_id, participant_id: p.id,
              question_id: q.question_id, question_text: q.question_text, question_theme: q.question_theme,
              phase: 'pre', response_value: rv, response_text: rt,
            });
          }
          // Mark participant pre_status complete
          await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH',
            { pre_status: 'complete' }, { Prefer: 'return=minimal' });
        }

        // Insert in batches of 50
        for (let i = 0; i < rows.length; i += 50) {
          await sb('/rest/v1/workshop_responses', 'POST', rows.slice(i, i + 50), { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, responses_created: rows.length, participants: parts.length });
      }

      // ── Full Excel export (returns JSON payload; client-side SheetJS builds XLSX)

      case 'export-full-excel': {
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(body.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const sponsor = w.sponsor_client_id ? await sbOne(`/rest/v1/clients?id=eq.${enc(w.sponsor_client_id)}&select=name,email&limit=1`) : null;
        let org = null;
        if (w.organization_id) org = await sbOne(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=name,industry,size_band&limit=1`);
        const agg = await aggregate(body.workshop_id);

        // All participants with client details
        const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(body.workshop_id)}&select=id,client_id,role,department,location,pre_status,invited_at,last_reminder_at`);
        const clientMap = {};
        for (const p of parts) {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
          if (c) clientMap[p.id] = c;
        }

        // All responses
        const resp = await sbGet(`/rest/v1/workshop_responses?workshop_id=eq.${enc(body.workshop_id)}&select=participant_id,phase,question_id,question_text,question_theme,response_value,response_text,created_at&order=participant_id.asc,question_id.asc`);

        // Sheet 1: Overview
        const overview = [
          ['Assessment Title', w.title],
          ['Organization', org?.name || w.client_org_name || ''],
          ['Industry', org?.industry || w.industry || ''],
          ['Size Band', org?.size_band || w.company_size_band || ''],
          ['Audience Level', w.audience_level || ''],
          ['Internal Tags', (w.tags || []).join(', ')],
          ['Debrief Date', w.debrief_date || ''],
          ['Sponsor Name', sponsor?.name || ''],
          ['Sponsor Email', sponsor?.email || ''],
          [],
          ['Participants', agg.participation.total],
          ['Response Rate', agg.participation.pre.rate + '%'],
          ['Trust Index', agg.tp3?.trust?.pre ?? ''],
          ['Proactivity Index', agg.tp3?.proactivity?.pre ?? ''],
          ['Productivity Index', agg.tp3?.productivity?.pre ?? ''],
          ['NPS', agg.nps ?? ''],
          [],
          ['Discovery Notes (excerpt)', (w.discovery_transcript || w.discovery_notes || '').slice(0, 2000)],
        ];

        // Sheet 2: Responses (wide pivot: one row per participant, columns per question)
        const qs = await sbGet(`/rest/v1/workshop_questions?workshop_id=eq.${enc(body.workshop_id)}&status=eq.approved&order=sort_order.asc`);
        const qIds = qs.map(q => q.question_id);
        const qTexts = qs.map(q => q.question_text.slice(0, 80));
        const responseHeader = ['Participant ID', 'Name', 'Email', 'Role', 'Department', 'Location', 'Status', ...qTexts];
        const responseRows = [responseHeader];

        for (const p of parts) {
          const c = clientMap[p.id] || {};
          const pResp = resp.filter(r => r.participant_id === p.id);
          const vals = qIds.map(qid => {
            const r = pResp.find(x => x.question_id === qid);
            if (!r) return '';
            return r.response_value != null ? r.response_value : (r.response_text || '');
          });
          responseRows.push([p.id, c.name || '', c.email || '', p.role || '', p.department || '', p.location || '', p.pre_status || '', ...vals]);
        }

        // Sheet 3: Verbatims (qualitative only)
        const qualHeader = ['Participant ID', 'Question ID', 'Question Theme', 'Question Text', 'Response'];
        const qualRows = [qualHeader, ...resp.filter(r => r.response_text && !r.response_value).map(r => [r.participant_id, r.question_id, r.question_theme, r.question_text, r.response_text])];

        return res.status(200).json({
          ok: true,
          filename: `${(w.title || 'assessment').replace(/[^a-zA-Z0-9]/g, '_')}_full_export.xlsx`,
          sheets: [
            { name: 'Overview', rows: overview },
            { name: 'Responses', rows: responseRows },
            { name: 'Verbatims', rows: qualRows },
          ],
        });
      }

      // ── Upload discovery attachment to Supabase Storage ───────────────────────

      case 'upload-discovery-attachment': {
        const id = body.workshop_id;
        const dataUrl = body.data;
        const filename = (body.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!id || !dataUrl) return res.status(400).json({ error: 'workshop_id and data required' });
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'Invalid data URL' });
        const mime = match[1];
        const buf  = Buffer.from(match[2], 'base64');
        if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (10 MB max)' });
        const path = `discovery/${id}/${Date.now()}_${filename}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/org-assets/${path}`, {
          method: 'POST',
          headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': mime },
          body: buf,
        });
        if (!up.ok) {
          const err = await up.json().catch(() => ({}));
          return res.status(500).json({ error: err.message || 'Storage upload failed' });
        }
        const url = `${SUPABASE_URL}/storage/v1/object/public/org-assets/${path}`;
        await sb(`/rest/v1/workshops?id=eq.${enc(id)}`, 'PATCH',
          { discovery_attachment_url: url, updated_at: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, url });
      }

      // ── Get roster with full client details (name, email, status) ────────────

      case 'get-roster': {
        const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(body.workshop_id)}&select=id,client_id,role,department,location,pre_status,post_status,invited_at,last_reminder_at&order=created_at.asc`);
        const enriched = await Promise.all(parts.map(async p => {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
          let status = 'not_sent';
          if (p.pre_status === 'complete') status = 'completed';
          else if (p.last_reminder_at) status = 'reminder_sent';
          else if (p.invited_at) status = 'sent';
          return { ...p, name: c?.name || '', email: c?.email || '', display_status: status };
        }));
        return res.status(200).json({ ok: true, participants: enriched });
      }

      // ── Workshop sponsor management (multi-sponsor via workshop_sponsors) ─────

      // List sponsors attached to a workshop
      case 'get-workshop-sponsors': {
        const wid = body.workshop_id;
        if (!wid) return res.status(400).json({ error: 'workshop_id required' });
        const links = await sbGet(`/rest/v1/workshop_sponsors?workshop_id=eq.${enc(wid)}&select=id,client_id,added_at,sponsor_title&order=added_at.asc`);
        const sponsors = await Promise.all(links.map(async l => {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(l.client_id)}&select=name,email,title,token&limit=1`);
          // Build portal link server-side; never send raw token to the browser.
          const PORTAL = process.env.PORTAL_BASE_URL || 'https://portal.gpsleadership.org';
          const portalLink = c?.token ? `${PORTAL}/client.html?token=${encodeURIComponent(c.token)}` : null;
          // Prefer the junction-level sponsor title (per-workshop) over the shared clients.title.
          return { ...l, name: c?.name || '', email: c?.email || '', title: l.sponsor_title || c?.title || '', portalLink };
        }));
        return res.status(200).json({ ok: true, sponsors });
      }

      // Add a sponsor to a workshop (by email — creates client record if needed)
      case 'add-workshop-sponsor': {
        const wid   = body.workshop_id;
        const email = (body.email || '').trim().toLowerCase();
        const name  = (body.name  || '').trim();
        const title = (body.title || '').trim() || null;
        if (!wid || !email) return res.status(400).json({ error: 'workshop_id and email required' });
        // Find or create the client record for this sponsor.
        let client = await sbOne(`/rest/v1/clients?email=eq.${enc(email)}&select=id,name,title,in_coaching_program,is_workshop_participant&limit=1`);
        let roleConflict = null;
        if (!client) {
          if (!name) return res.status(400).json({ error: 'name required when adding a new sponsor' });
          const ins = await sb('/rest/v1/clients', 'POST', {
            name, email, title, token: crypto.randomUUID(),
            in_coaching_program: false, is_active: true, is_sponsor: true,
          }, { Prefer: 'return=representation' });
          const rows = await ins.json().catch(() => []);
          client = Array.isArray(rows) ? rows[0] : rows;
          if (!client?.id) return res.status(500).json({ error: 'Failed to create sponsor record' });
        } else {
          // Existing record — mark as sponsor, but never overwrite a coaching client's fields.
          await sb(`/rest/v1/clients?id=eq.${enc(client.id)}`, 'PATCH', { is_sponsor: true }, { Prefer: 'return=minimal' });
          if (client.in_coaching_program) roleConflict = 'coaching client';
          else if (client.is_workshop_participant) roleConflict = 'workshop participant';
        }
        // Insert into junction (ignore duplicate). The sponsor's title lives on the junction,
        // not on the (possibly shared) clients row.
        await sb('/rest/v1/workshop_sponsors', 'POST',
          { workshop_id: wid, client_id: client.id, sponsor_title: title },
          { Prefer: 'resolution=ignore,return=minimal' });
        // Keep the single-field pointer in sync so the Overview + sponsor dashboard never go blank.
        const w0 = await sbOne(`/rest/v1/workshops?id=eq.${enc(wid)}&select=sponsor_client_id&limit=1`);
        if (w0 && !w0.sponsor_client_id) {
          await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH', { sponsor_client_id: client.id }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, client_id: client.id, name: client.name, warning: roleConflict ? `This email already belongs to a ${roleConflict}; they are now also marked as a sponsor.` : null });
      }

      // Remove a sponsor from a workshop
      case 'remove-workshop-sponsor': {
        const wid = body.workshop_id;
        const cid = body.client_id;
        if (!wid || !cid) return res.status(400).json({ error: 'workshop_id and client_id required' });
        await sb(`/rest/v1/workshop_sponsors?workshop_id=eq.${enc(wid)}&client_id=eq.${enc(cid)}`, 'DELETE');
        // If we just removed the primary sponsor, repoint the single-field pointer to a remaining one (or clear it).
        const wRem = await sbOne(`/rest/v1/workshops?id=eq.${enc(wid)}&select=sponsor_client_id&limit=1`);
        if (wRem && wRem.sponsor_client_id === cid) {
          const next = await sbOne(`/rest/v1/workshop_sponsors?workshop_id=eq.${enc(wid)}&select=client_id&order=added_at.asc&limit=1`);
          await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH', { sponsor_client_id: next ? next.client_id : null }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }

      // Lock the roster so sponsors can no longer upload/replace it
      case 'lock-roster': {
        const wid = body.workshop_id;
        if (!wid) return res.status(400).json({ error: 'workshop_id required' });
        await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH',
          { roster_locked: true, updated_at: isoNow() },
          { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // Store roster file URL after upload (coach sets after upload to Supabase Storage)
      case 'set-roster-file': {
        const wid = body.workshop_id;
        const url = body.file_url;
        if (!wid || !url) return res.status(400).json({ error: 'workshop_id and file_url required' });
        await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH',
          { roster_file_url: url, roster_uploaded_at: isoNow(), updated_at: isoNow() },
          { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // Get a single org with all linked projects (workshops + diagnostics)
      case 'org-get': {
        const id = body.org_id;
        if (!id) return res.status(400).json({ error: 'org_id required' });
        const [org, workshops] = await Promise.all([
          sbOne(`/rest/v1/organizations?id=eq.${enc(id)}&limit=1`),
          sbGet(`/rest/v1/workshops?organization_id=eq.${enc(id)}&select=id,title,engagement_kind,status,workshop_date,client_org_name,roster_locked,roster_uploaded_at&order=created_at.desc&limit=50`),
        ]);
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        // TODO: add diagnostics/teams linked to this org when that relationship is added
        return res.status(200).json({ ok: true, organization: org, workshops });
      }

      // Link a Decision Room sponsor record to a client portal record (unified access)
      case 'link-sponsor-to-client': {
        const sponsorId = body.sponsor_id;
        const clientId  = body.client_id;
        if (!sponsorId || !clientId) return res.status(400).json({ error: 'sponsor_id and client_id required' });
        await sb(`/rest/v1/sponsors?id=eq.${enc(sponsorId)}`, 'PATCH',
          { linked_client_id: clientId },
          { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

function recToFit(rec) {
  const step = rec?.primary?.step || '';
  if (/Diagnostic/i.test(step)) return 'yes';
  if (/Reset|Retreat/i.test(step)) return 'maybe';
  return 'no';
}

// ── Survey reminder cron ─────────────────────────────────────────────────────
// Cadence: day the survey opens, 3 days before close, 1 day before close, and
// the morning of close. Sends only to participants who haven't completed.
async function runReminders() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const workshops = await sbGet(`/rest/v1/workshops?is_archived=eq.false&select=id,title,pre_survey_open_at,pre_survey_close_at,post_survey_open_at,post_survey_close_at&or=(status.eq.pre_survey_open,status.eq.post_survey_open)`);
  let nudged = 0;
  for (const w of workshops) {
    for (const phase of ['pre', 'post']) {
      const closeAt = phase === 'pre' ? w.pre_survey_close_at : w.post_survey_close_at;
      if (!closeAt) continue;
      const days = Math.ceil((new Date(closeAt) - now) / 86400000);
      // Only nudge on the cadence days (open handled by send-invites): 3, 1, 0 days out.
      if (![3, 1, 0].includes(days)) continue;
      const statusCol = phase === 'pre' ? 'pre_status' : 'post_status';
      const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(w.id)}&${statusCol}=neq.complete&select=id,participant_token,client_id`);
      for (const p of parts) {
        const c = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,email&limit=1`);
        if (!c?.email) continue;
        const url = `${PORTAL_BASE_URL}/workshop-survey?token=${enc(p.participant_token)}&phase=${phase}`;
        const when = days === 0 ? 'closes today' : `closes in ${days} day${days === 1 ? '' : 's'}`;
        const html = reminderHtml(c.name, w, phase, url, when);
        const r = await sendEmail(c.email, `Reminder: your ${w.title} survey ${when}`, html);
        if (r.ok) nudged++;
      }
    }
  }
  return { workshops: workshops.length, nudged, ran_at: today };
}

// ── Email bodies (plain, on-brand, no hype) ──────────────────────────────────
function shell(inner) {
  return `<div style="font-family:'Open Sans',Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a2332;line-height:1.55;font-size:15px;">${inner}<p style="margin-top:28px;color:#6b7280;font-size:13px;">— Alex Tremble, GPS Leadership Solutions</p></div>`;
}
function btn(url, label) {
  return `<p style="margin:22px 0;"><a href="${url}" style="background:#0d9488;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;display:inline-block;">${label}</a></p>`;
}
function inviteHtml(name, w, phase, url) {
  const lead = phase === 'pre'
    ? `Before our <strong>${w.title}</strong> session, I'd like your honest read on how the team is operating today. It takes about 5-7 minutes and your answers are confidential — I only ever share the team-level picture.`
    : `Now that the <strong>${w.title}</strong> workshop is behind us, a short follow-up (about 5 minutes) helps us see what actually shifted. Confidential, team-level only.`;
  return shell(`<p>Hi ${escEmail(name)},</p><p>${lead}</p>${btn(url, phase === 'pre' ? 'Start the pre-work (5-7 min)' : 'Start the follow-up (5 min)')}<p style="color:#6b7280;font-size:13px;">You can save and come back to this link anytime before it closes.</p>`);
}
function reminderHtml(name, w, phase, url, when) {
  return shell(`<p>Hi ${escEmail(name)},</p><p>A quick nudge — your ${phase === 'pre' ? 'pre-work' : 'follow-up'} survey for <strong>${w.title}</strong> ${when}. It only takes a few minutes and your input shapes what we focus on.</p>${btn(url, 'Finish the survey')}`);
}
function recapHtml(name, w, agg, findings, rec) {
  const p = agg.participation;
  const line = (l, v) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${l}</td><td style="padding:4px 0;font-weight:700;">${v ?? '—'}</td></tr>`;
  const list = (arr) => arr && arr.length ? `<ul style="margin:6px 0 14px;padding-left:18px;">${arr.map(x => `<li>${escEmail(x)}</li>`).join('')}</ul>` : '<p style="color:#6b7280;">—</p>';
  const dash = w.sponsor_token ? btn(`${PORTAL_BASE_URL}/workshop-room?token=${enc(w.sponsor_token)}`, 'Open your workshop dashboard') : '';
  const cta = (rec?.primary && /Diagnostic/i.test(rec.primary.step))
    ? `<p style="margin-top:18px;">If you want to act on this: the <strong>14-Day Executive Leadership Diagnostic</strong> is the fastest way to fix the pattern the data shows. Reply to this email and I'll set it up.</p>` : '';
  return shell(`<p>Hi ${escEmail(name)},</p>
<p>Here's the recap from <strong>${w.title}</strong>.</p>
<table style="border-collapse:collapse;margin:10px 0 16px;">
${line('Participation (pre)', p.pre.rate + '%')}${line('Participation (post)', p.post.rate + '%')}${line('Workshop NPS', agg.nps)}
${line('Trust', fmtBA(agg.tp3.trust))}${line('Proactivity', fmtBA(agg.tp3.proactivity))}${line('Productivity', fmtBA(agg.tp3.productivity))}
</table>
<p style="font-weight:700;margin-bottom:2px;">Top strengths</p>${list(findings.strengths)}
<p style="font-weight:700;margin-bottom:2px;">Top risks</p>${list(findings.risks)}
<p style="font-weight:700;margin-bottom:2px;">Recommended 90-day focus</p>${list((w.exec_summary_json && w.exec_summary_json.focus90) || [])}
${dash}${cta}`);
}
function fmtBA(t) { if (!t) return '—'; if (t.pre != null && t.post != null) return `${t.pre} → ${t.post}`; return (t.post ?? t.pre ?? '—'); }
function escEmail(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
