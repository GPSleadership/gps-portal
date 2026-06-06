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
        const patch = { updated_at: isoNow() };
        if (phase === 'pre')  { patch.pre_survey_open_at  = patch.pre_survey_open_at  || isoNow(); patch.status = 'pre_survey_open'; }
        else                  { patch.post_survey_open_at = patch.post_survey_open_at || isoNow(); patch.status = 'post_survey_open'; }
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
