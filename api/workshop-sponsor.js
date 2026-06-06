// GPS Leadership — Workshop Sponsor Dashboard API (read-only)
//
// THE read boundary for the sponsor/leader workshop dashboard (workshop-room.html).
// Validates a sponsor_token (service-role lookup), assembles an already-scoped,
// AGGREGATE-ONLY payload (never per-participant data — individuals are protected
// by aggregation), and returns it. The page only renders what this returns.
// Modeled on api/sponsor-data.js.
//
// POST /api/workshop-sponsor  { token }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function sbGet(path) { const r = await sb(path); if (!r.ok) return []; const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; }
async function sbOne(path) { return (await sbGet(path))[0] || null; }

function avg(nums) { const v = (nums || []).filter(s => s != null && !isNaN(s)).map(Number); if (!v.length) return null; return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100; }
function round2(x) { return x == null ? null : Math.round(Number(x) * 100) / 100; }
const TP3_THEMES = ['trust', 'proactivity', 'productivity'];

// Aggregate (aggregate-only; mirrors workshop-data.js so the dashboard never
// diverges from the coach view).
async function aggregate(workshopId) {
  const parts = await sbGet(`/rest/v1/workshop_participants?workshop_id=eq.${enc(workshopId)}&select=pre_status,post_status`);
  const resp  = await sbGet(`/rest/v1/workshop_responses?workshop_id=eq.${enc(workshopId)}&select=phase,question_theme,question_id,response_value,response_text`);
  const total = parts.length;
  const preDone = parts.filter(p => p.pre_status === 'complete').length;
  const postDone = parts.filter(p => p.post_status === 'complete').length;

  const themesByPhase = { pre: {}, post: {} };
  const npsRaw = { pre: [], post: [] };
  for (const r of resp) {
    const ph = r.phase === 'post' ? 'post' : (r.phase === 'pre' ? 'pre' : null);
    if (!ph || r.response_value == null || isNaN(r.response_value)) continue;
    if (String(r.question_id).startsWith('NPS')) { npsRaw[ph].push(Number(r.response_value)); continue; }
    const t = r.question_theme || 'other';
    (themesByPhase[ph][t] = themesByPhase[ph][t] || []).push(Number(r.response_value));
  }
  const themeAvg = ph => Object.fromEntries(Object.entries(themesByPhase[ph]).map(([t, a]) => [t, avg(a)]));
  const preThemes = themeAvg('pre'), postThemes = themeAvg('post');

  const tp3 = {};
  for (const t of TP3_THEMES) {
    const pre = preThemes[t] ?? null, post = postThemes[t] ?? null;
    tp3[t] = { pre, post, delta: (pre != null && post != null) ? round2(post - pre) : null };
  }
  const allThemes = Array.from(new Set([...Object.keys(preThemes), ...Object.keys(postThemes)]));
  const themeTable = allThemes.map(t => ({ theme: t, pre: preThemes[t] ?? null, post: postThemes[t] ?? null, delta: (preThemes[t] != null && postThemes[t] != null) ? round2(postThemes[t] - preThemes[t]) : null }));

  const npsScores = npsRaw.post.length ? npsRaw.post : npsRaw.pre;
  let nps = null, npsAvg = null;
  if (npsScores.length) { const prom = npsScores.filter(s => s >= 9).length; const detr = npsScores.filter(s => s <= 6).length; nps = Math.round(((prom - detr) / npsScores.length) * 100); npsAvg = avg(npsScores); }

  return {
    participation: { total, pre: { done: preDone, rate: total ? Math.round((preDone / total) * 100) : 0 }, post: { done: postDone, rate: total ? Math.round((postDone / total) * 100) : 0 } },
    tp3, themeTable, nps, npsAvg,
  };
}

function findings(agg) {
  const strengths = [], risks = [];
  const label = { trust: 'Trust', proactivity: 'Proactivity / ownership', productivity: 'Productivity / focus', delegation: 'Delegation', meetings: 'Meeting effectiveness', communication: 'Communication', satisfaction: 'Satisfaction' };
  for (const row of agg.themeTable) {
    const v = row.post ?? row.pre; if (v == null) continue;
    const name = label[row.theme] || row.theme;
    if (v >= 4.0) strengths.push(`${name} is a strength (${v}/5).`);
    else if (v < 3.0) risks.push(`${name} is a risk (${v}/5) and is likely costing time day to day.`);
  }
  return { strengths: strengths.slice(0, 4), risks: risks.slice(0, 4) };
}

// Ordered lifecycle → timeline. Each milestone: state done|current|upcoming.
const LIFECYCLE = [
  ['discovery_complete',  'Discovery call completed'],
  ['questions_drafted',   'Survey questions developed'],
  ['sponsor_review',      'Sponsor review of questions'],
  ['pre_survey_open',     'Pre-workshop survey live'],
  ['pre_survey_closed',   'Pre-survey closed — data in review'],
  ['workshop_delivered',  'Workshop delivered'],
  ['post_survey_open',    'Post-workshop survey live'],
  ['post_survey_closed',  'Post-survey closed — data in review'],
  ['debrief_scheduled',   'Debrief with sponsor'],
  ['complete',            'Report & recommendations ready'],
];
function statusIndex(status) {
  const order = ['setup', 'discovery_complete', 'questions_drafted', 'sponsor_review', 'pre_survey_open', 'pre_survey_closed', 'workshop_delivered', 'post_survey_open', 'post_survey_closed', 'debrief_scheduled', 'report_uploaded', 'complete'];
  const i = order.indexOf(status); return i < 0 ? 0 : i;
}
function buildTimeline(w, agg) {
  const order = ['setup', 'discovery_complete', 'questions_drafted', 'sponsor_review', 'pre_survey_open', 'pre_survey_closed', 'workshop_delivered', 'post_survey_open', 'post_survey_closed', 'debrief_scheduled', 'report_uploaded', 'complete'];
  const cur = statusIndex(w.status);
  return LIFECYCLE.map(([key, label]) => {
    const idx = order.indexOf(key);
    const state = idx < cur ? 'done' : (idx === cur ? 'current' : 'upcoming');
    const m = { key, label, state };
    if (key === 'pre_survey_open')  { m.detail = `${agg.participation.pre.done} of ${agg.participation.total} (${agg.participation.pre.rate}%)`; m.countdown_to = w.workshop_date; }
    if (key === 'post_survey_open') { m.detail = `${agg.participation.post.done} of ${agg.participation.total} (${agg.participation.post.rate}%)`; }
    if (key === 'workshop_delivered') m.date = w.workshop_date;
    if (key === 'debrief_scheduled')  m.date = w.debrief_date;
    return m;
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const token = (req.body || {}).token;
  try {
    const w = await sbOne(`/rest/v1/workshops?sponsor_token=eq.${enc(token)}&select=*&limit=1`);
    if (!w) return res.status(401).json({ error: 'Invalid or expired link' });
    sb(`/rest/v1/workshops?id=eq.${w.id}`, 'PATCH', { token_last_used_at: new Date().toISOString() }, { Prefer: 'return=minimal' }).catch(() => {});

    const agg = await aggregate(w.id);
    const f = findings(agg);
    const summary = w.exec_summary_json || null;
    const rec = w.recommendation_json || null;

    // Coach-configurable scheduling link for the recommendation CTA.
    const cs = await sbOne(`/rest/v1/coach_settings?key=eq.workshop_cta_url&select=value&limit=1`);
    const ctaUrl = (cs && cs.value) || 'https://api.leadconnectorhq.com/widget/bookings/30-minute-coaching-discovery-call';

    // Approved, public-permission testimonials for this workshop (optional surface).
    const testimonials = w.sponsor_client_id
      ? await sbGet(`/rest/v1/testimonials?workshop_id=eq.${enc(w.id)}&permission_public_use=eq.true&select=responses,rating_nps,created_at&order=created_at.desc`)
      : [];

    // Coach must review/approve the AI-authored narrative before the sponsor sees
    // it (safe-build rule: no un-reviewed AI output goes external). Numbers
    // (participation, NPS, TP3, the pre/post theme table, timeline) are factual
    // and always shown; the written strengths/risks/90-day focus + recommendation
    // are withheld until summary_approved.
    const approved = !!w.summary_approved;

    return res.status(200).json({
      ok: true,
      finalizing: !approved,
      workshop: {
        title: w.title, org: w.client_org_name, workshop_date: w.workshop_date, debrief_date: w.debrief_date,
        industry: w.industry, audience_level: w.audience_level, status: w.status,
      },
      exec_summary: {
        participation: agg.participation, nps: agg.nps, npsAvg: agg.npsAvg, tp3: agg.tp3,
        strengths: approved ? ((summary && summary.strengths) || f.strengths) : [],
        risks:     approved ? ((summary && summary.risks) || f.risks) : [],
        focus90:   approved ? ((summary && summary.focus90) || []) : [],
      },
      themeTable: agg.themeTable,
      timeline: buildTimeline(w, agg),
      recommendation: approved ? rec : null,
      findings: approved ? f : { strengths: [], risks: [] },
      cta_url: ctaUrl,
      testimonials,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
