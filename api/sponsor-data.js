// GPS Leadership — Sponsor (Decision Room) Data API
//
// THE SECURITY BOUNDARY for the Decision Room. Modeled on api/diag-portal.js.
//
// Post-v26 model: the browser never touches Supabase. This endpoint validates a
// sponsor_token (service-role lookup), enforces the hard feedback gate, enforces
// per-engagement confidentiality by OMITTING the confidential self-vs-raters
// data from the response (never "hidden" client-side, never relying on RLS —
// the service role bypasses RLS), and returns a fully-assembled, already-scoped
// payload. The page only renders what this endpoint returns.
//
// POST /api/sponsor-data  { action, token, team_id? }
//   action = 'list-teams' | 'team'
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

const enc = encodeURIComponent;

const crypto = require('crypto');
// Mirrors the same HMAC-based session verification used in api/diagnostic.js.
function verifyCoachSession(tok) {
  if (!tok || !COACH_SESSION_SECRET) return false;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest());
  const actual   = Buffer.from(parts[1], 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
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
async function sbGet(path) {
  const r = await sb(path);
  if (!r.ok) return [];
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

// ── Diagnostic scoring — replicated EXACTLY from api/diagnostic.js so the
//    Decision Room never diverges from the report. Scale 1-5. ────────────────
const TRUST_CODES = ['A1','A2','A3','A4','A5','A6','A7'];
const PROACT_CODES = ['B1','B2','B3','B4','B5','B6'];
const PROD_CODES = ['C1','C2','C3','C4','C5','C6'];
function avg(nums) {
  const v = nums.filter(s => s != null && !isNaN(s));
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + Number(b), 0) / v.length) * 100) / 100;
}
function tp3From(responses) {
  const byCode = {};
  for (const r of responses) {
    if (r.score == null) continue;
    (byCode[r.question_code] = byCode[r.question_code] || []).push(Number(r.score));
  }
  const qAvg = codes => avg(codes.flatMap(c => byCode[c] || []));
  return { trust: qAvg(TRUST_CODES), proactivity: qAvg(PROACT_CODES), productivity: qAvg(PROD_CODES) };
}

// ── Color band thresholds (1-5), shared with the page ───────────────────────
function band(v) { if (v == null) return null; return v >= 4.0 ? 'green' : (v >= 3.0 ? 'amber' : 'red'); }

// ── Survey (90-day stakeholder) scale — scale-aware, branch on cycle.
//    The survey is moving to collect 1-5 natively (matches TP3 and the whole
//    Decision Room color system). Each survey_responses row carries the scale
//    it was collected on (`scale`, default 5; legacy rows backfilled to 10 by
//    migration v28). We normalize every row to a 1-5 value by its OWN scale, so
//    new 1-5 data passes through untouched and any legacy 1-10 data is never
//    misread. No blind ÷2. ─────────────────────────────────────────────────────
function norm5(score, scale) {
  if (score == null) return null;
  const s = Number(scale) || 5;
  return Math.round((Number(score) / s * 5) * 100) / 100;
}

// Map the 90-day survey checkpoint labels to baseline / d30 / d90.
function cpKey(checkpoint) {
  const c = String(checkpoint || '').toLowerCase();
  if (c.includes('90')) return 'd90';
  if (c.includes('45') || c.includes('30')) return 'd30';
  return 'baseline';
}

async function sponsorByToken(token) {
  if (!token) return null;
  const rows = await sbGet(`/rest/v1/sponsors?sponsor_token=eq.${enc(token)}&active=eq.true&limit=1`);
  return rows[0] || null;
}

// Members of a team this sponsor may see, each with the resolved engagement.
async function teamMembers(teamId) {
  const tms = await sbGet(`/rest/v1/team_members?team_id=eq.${enc(teamId)}&select=*&order=sort_order.asc`);
  return tms;
}

// Is the supervisor (this sponsor) outstanding on feedback for the members they
// supervise? Reads completion from the SAME existing survey the portal uses.
async function feedbackOwed(supervisesClientIds, members) {
  const owed = [];
  for (const m of members) {
    if (!supervisesClientIds.includes(m.client_id)) continue;
    // The supervisor's own stakeholder row for this member (coaching scoreboard).
    const stps = await sbGet(`/rest/v1/stakeholders?client_id=eq.${enc(m.client_id)}&is_supervisor=eq.true&is_active=eq.true&select=id&limit=1`);
    const stk = stps[0];
    if (!stk) continue;
    // Outstanding = a survey_token that was SENT to this supervisor stakeholder
    // but is not yet used. Ties the gate to the real feedback-request lifecycle:
    // nothing is owed until you've actually asked, and it clears on submit.
    const toks = await sbGet(`/rest/v1/survey_tokens?stakeholder_id=eq.${enc(stk.id)}&is_used=eq.false&sent_at=not.is.null&select=id,token,checkpoint&order=created_at.desc&limit=1`);
    if (toks[0]) owed.push({ member: m.role || 'leader', client_id: m.client_id, checkpoint: toks[0].checkpoint, token: toks[0].token });
  }
  return owed;
}

// Assemble one member's report. `confidential` => omit the self-vs-raters card
// and any diagnostic-derived flag entirely (never fetched/sent).
async function buildMemberReport(m, confidential) {
  const report = {};
  report.id = m.id;
  report.client_id = m.client_id;
  report.role = m.role;
  report.is_coaching_client = m.is_coaching_client;
  report.coach_summary = m.coach_summary || null;
  // Keep the AI content NESTED under report_json — the sponsor page reads
  // m.report_json.{succession, focus, summaryLine, name, readinessLevel}.
  report.report_json = Object.assign({}, m.report_json || {});
  // Surface the leader's name at the top level too, so the roster, nine-box grid,
  // and succession table label people by NAME, not "Leader 1/2/3". The report_json
  // name only exists after a report is generated, so fall back to the client record.
  // (Confidentiality hides individual SCORES, not identities, so names are fine.)
  report.name = report.report_json.name || null;
  if (!report.name) {
    try {
      const crow = await sbGet(`/rest/v1/clients?id=eq.${enc(m.client_id)}&select=name&limit=1`);
      if (crow && crow[0] && crow[0].name) report.name = crow[0].name;
    } catch (_) { /* non-fatal: falls back to role/Leader N */ }
  }

  // 90-day stakeholder scoreboard + engagement (post-diagnostic — always shown)
  report.scoreboard = await buildScoreboard(m.client_id);
  report.engagement = await buildEngagement(m.client_id);
  // Process pipeline — where this leader is in the diagnostic (shown to sponsors too).
  report.pipeline = await buildPipeline(m.client_id);

  // The leader's REAL 90-day focus: the goal + metric they actually chose in their
  // own portal. Pulled live from the plan so the sponsor sees what the leader sees,
  // and so it isn't overwritten by the AI content generation. Falls back to the
  // generated recommended focus (report_json.focus) when there's no active plan.
  const planFocus = await buildPlanFocus(m.client_id, report.scoreboard);
  if (planFocus) report.report_json.focus = planFocus;

  // Engagement-level business outcome the dev plan ladders up to (e.g. "Drive 3-5%
  // annual revenue growth"). Shown to the sponsor regardless of whether the leader
  // has built their 90-day plan yet. Not confidential — it's the business target.
  try {
    const bo = await sbGet(`/rest/v1/clients?id=eq.${enc(m.client_id)}&select=business_outcome_goal,sponsor_outcome_focus&limit=1`);
    const boRow = bo && bo[0];
    // Only sponsor-driven engagements expose a business outcome (omit server-side otherwise).
    report.business_outcome_goal = (boRow && boRow.sponsor_outcome_focus && boRow.business_outcome_goal) ? boRow.business_outcome_goal : null;
  } catch (_) { report.business_outcome_goal = null; }

  if (!confidential) {
    // Confidential 360 detail — ONLY assembled for non-private engagements.
    report.selfVsRaters = await buildSelfVsRaters(m.client_id);
    // Sponsor manager-view readout: aggregate by-group scores (incl "Other colleagues"),
    // the sponsor's OWN written comments (they wrote them), bench/succession, plan-approval
    // state, debrief. Peer/direct-report verbatims are NEVER fetched here — confidentiality.
    report.sponsorReadout = await buildSponsorReadout(m.client_id);
  }
  // In private mode selfVsRaters/sponsorReadout are never set, so the browser never receives them.
  return report;
}

// Manager/sponsor readout for one leader: aggregate scores + sponsor's own input only.
// Numbers come from the latest report draft's scores_json (by_group includes the
// "Other colleagues" cohort). Verbatims are restricted to the SUPERVISOR's own
// comments — peer and direct-report open-ended responses are never queried here.
async function buildSponsorReadout(clientId) {
  let d = null;
  try {
    const r = await sbGet(`/rest/v1/diagnostics?client_id=eq.${enc(clientId)}&is_archived=eq.false&select=id,debrief_date,debrief_time,plan_requires_sponsor_approval,plan_sponsor_status,plan_sponsor_decided_at,plan_sponsor_note,self_three_year_vision,self_successor_candidates,self_successor_development_actions,custom_g1_question,custom_g2_question&order=created_at.desc&limit=1`);
    d = r && r[0];
  } catch (_) { /* no diagnostic */ }
  if (!d) return null;

  let scores = null;
  try {
    const sr = await sbGet(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${enc(d.id)}&select=scores_json,generated_at&order=generated_at.desc&limit=1`);
    if (sr && sr[0] && sr[0].scores_json) scores = sr[0].scores_json;
  } catch (_) { /* scores optional */ }

  let sponsorVerbatims = [];
  try {
    const vr = await sbGet(`/rest/v1/diagnostic_responses?diagnostic_id=eq.${enc(d.id)}&rater_relationship=ilike.*supervisor*&text_response=not.is.null&select=text_response&limit=40`);
    sponsorVerbatims = (vr || []).map(x => String(x.text_response || '').trim()).filter(t => t.length > 15).slice(0, 4);
  } catch (_) { /* verbatims optional */ }

  return {
    scores,                                   // tp3_index, trust/proactivity/productivity, impact, bench, by_group{...}
    sponsor_verbatims: sponsorVerbatims,      // supervisor's OWN comments only
    custom_questions: [d.custom_g1_question, d.custom_g2_question].filter(Boolean),
    // PRIVACY: the leader's self-assessment (3-year vision, named successor, and
    // development plan) is personal/confidential and must NOT reach the sponsor.
    // The sponsor sees ONLY a clean boolean signal — whether a successor has been
    // identified — never the leader's private direction or free-text.
    succession: { successor_identified: !!(d.self_successor_candidates && String(d.self_successor_candidates).trim()) },
    debrief: { date: d.debrief_date || null, time: d.debrief_time || null },
    plan_approval: {
      requires:    !!d.plan_requires_sponsor_approval,
      status:      d.plan_sponsor_status || 'none',
      decided_at:  d.plan_sponsor_decided_at || null,
      note:        d.plan_sponsor_note || null,
    },
  };
}

// Status-only row for a 'progress' POC. Returns NAME + role + where this person
// is in the process (diagnostic + assessment) — and NOTHING that reveals results:
// no scoreboard, no report_json content, no coach_summary, no selfVsRaters.
async function buildMemberStatus(m) {
  const row = { id: m.id, client_id: m.client_id, role: m.role, status_only: true, name: null };
  // Identity is not confidential (scores are); fall back to the client record.
  let name = (m.report_json && m.report_json.name) || null;
  if (!name) {
    try {
      const cr = await sbGet(`/rest/v1/clients?id=eq.${enc(m.client_id)}&select=name&limit=1`);
      if (cr && cr[0] && cr[0].name) name = cr[0].name;
    } catch (_) { /* falls back to role */ }
  }
  row.name = name;

  // Where the leader is in their diagnostic process (full 7-stage pipeline).
  row.pipeline = await buildPipeline(m.client_id);

  // Where the leader is in the team assessment (invited yet + pre-survey status).
  let assessment = null;
  try {
    const wp = await sbGet(`/rest/v1/workshop_participants?client_id=eq.${enc(m.client_id)}&select=pre_status,invited_at&order=created_at.desc&limit=1`);
    if (wp && wp[0]) assessment = { invited: !!wp[0].invited_at, pre_status: wp[0].pre_status || 'pending' };
  } catch (_) { /* not in an assessment */ }
  row.assessment = assessment;

  return row;
}

// One leader's process pipeline — derived entirely from milestones already tracked
// on the diagnostic plus the kickoff date. Each stage carries a date + done flag,
// and current_label is the first not-yet-done stage. Reveals NO results — only
// where the person is and when each milestone happened/is scheduled.
async function buildPipeline(clientId) {
  let d = null;
  try {
    const r = await sbGet(`/rest/v1/diagnostics?client_id=eq.${enc(clientId)}&is_archived=eq.false&select=id,status,kickoff_date,kickoff_completed_at,invites_sent_at,invites_scheduled_at,all_raters_complete_at,survey_closed_at,close_date,report_finalized_at,report_release_at,report_generated_at,debrief_date,debrief_completed_at,plan_locked_at,plan_status&order=created_at.desc&limit=1`);
    d = r && r[0];
  } catch (_) { /* no diagnostic */ }
  if (!d) return null;

  let ratersTotal = 0;
  try { const rt = await sbGet(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${enc(d.id)}&select=id`); ratersTotal = (rt || []).length; } catch (_) { /* count optional */ }

  const ps = String(d.plan_status || '');
  const planActive = !!d.plan_locked_at || ['active', 'in_progress', 'locked'].includes(ps);
  const planComplete = ['complete', 'completed', 'closed', 'done'].includes(ps);

  // The report step stays "Drafting report" until it is actually released
  // (report_release_at, ~the evening before the debrief) — a finalized-but-unreleased
  // report is still being prepared from the sponsor's point of view.
  const reportReleased = !d.report_release_at || (new Date() >= new Date(d.report_release_at));
  const reportReady = reportReleased && !!(d.report_finalized_at || d.report_generated_at);

  const stages = [
    { key: 'kickoff',  label: 'Kickoff',             date: d.kickoff_date || null,                                                    done: !!d.kickoff_completed_at },
    { key: 'survey',   label: 'Survey sent',         date: d.invites_sent_at || d.invites_scheduled_at || null,                       done: !!d.invites_sent_at },
    { key: 'collect',  label: 'Collecting responses', date: d.all_raters_complete_at || d.survey_closed_at || d.close_date || null,    done: !!(d.all_raters_complete_at || d.survey_closed_at), note: ratersTotal ? (ratersTotal + ' rater' + (ratersTotal === 1 ? '' : 's') + ' loaded') : null },
    { key: 'report',   label: reportReady ? 'Report ready' : 'Drafting report', date: reportReady ? (d.report_release_at || d.report_finalized_at) : (d.report_release_at || null), done: reportReady },
    { key: 'debrief',  label: 'Debrief',             date: d.debrief_date || null,                                                    done: !!d.debrief_completed_at },
    { key: 'plan',     label: '90-day plan active',  date: d.plan_locked_at || null,                                                  done: planActive || planComplete },
    { key: 'complete', label: '90-day complete',     date: null,                                                                      done: planComplete },
  ];

  const current = stages.find(s => !s.done);
  return { stages, current_key: current ? current.key : 'complete', current_label: current ? current.label : '90-day complete' };
}

// The leader's real 90-day plan → focus card (goal, behaviors, their tracked
// metric, and the stakeholder rating of the worked behavior from the scoreboard).
async function buildPlanFocus(clientId, scoreboard) {
  const rows = await sbGet(`/rest/v1/clients?id=eq.${enc(clientId)}&select=goal_description,goal_statement,goal_30_day,behavior_1,behavior_2,metric_1_name,metric_1_baseline,metric_1_target&limit=1`);
  const c = rows && rows[0];
  if (!c) return null;
  const goal = c.goal_description || c.goal_statement || c.goal_30_day;
  if (!goal) return null;

  const behaviors = [c.behavior_1, c.behavior_2].filter(Boolean);

  let selfMetric = null;
  if (c.metric_1_name) {
    const cks = await sbGet(`/rest/v1/checkins?client_id=eq.${enc(clientId)}&select=week_number,metric_value&order=week_number.desc&limit=1`);
    const latest = cks && cks[0];
    selfMetric = {
      label:    c.metric_1_name,
      baseline: c.metric_1_baseline,
      target:   c.metric_1_target,
      current:  (latest && latest.metric_value != null) ? latest.metric_value : c.metric_1_baseline,
      unit:     '',
    };
  }

  let stakeholderMetric = null;
  if (scoreboard && scoreboard.length) {
    const av = (a) => { const v = a.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 100) / 100 : null; };
    const b = av(scoreboard.map(s => s.baseline));
    const cur = av(scoreboard.map(s => s.d90 != null ? s.d90 : s.d30));
    if (b != null && cur != null) stakeholderMetric = { label: 'Stakeholder rating of the worked behavior', baseline: b, target: 4.0, current: cur, unit: '' };
  }

  return { goal90: goal, behaviors, stakeholderMetric, selfMetric };
}

async function buildSelfVsRaters(clientId) {
  const diags = await sbGet(`/rest/v1/diagnostics?client_id=eq.${enc(clientId)}&select=id,status,survey_closed_at,close_date&order=created_at.desc&limit=1`);
  const diag = diags[0];
  if (!diag) return null;
  const surveyClosed = !!diag.survey_closed_at;
  if (!surveyClosed) return { surveyClosed: false, closesOn: diag.close_date || null };
  const raters = await sbGet(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${enc(diag.id)}&select=id,is_self`);
  const selfIds = new Set(raters.filter(r => r.is_self).map(r => r.id));
  const resp = await sbGet(`/rest/v1/diagnostic_responses?diagnostic_id=eq.${enc(diag.id)}&select=rater_id,question_code,score`);
  const selfResp = resp.filter(r => selfIds.has(r.rater_id));
  const otherResp = resp.filter(r => !selfIds.has(r.rater_id));
  const self = tp3From(selfResp);
  const raterAvg = tp3From(otherResp);
  return {
    surveyClosed: true,
    asOf: diag.survey_closed_at,
    tp3: {
      trust:        { self: self.trust,        raters: raterAvg.trust },
      proactivity:  { self: self.proactivity,  raters: raterAvg.proactivity },
      productivity: { self: self.productivity, raters: raterAvg.productivity },
    },
  };
}

async function buildScoreboard(clientId) {
  const stks = await sbGet(`/rest/v1/stakeholders?client_id=eq.${enc(clientId)}&is_active=eq.true&select=id,relationship,is_supervisor`);
  if (!stks.length) return null;
  const resp = await sbGet(`/rest/v1/survey_responses?client_id=eq.${enc(clientId)}&select=stakeholder_id,checkpoint,score,scale`);
  const byStk = {};
  for (const s of stks) byStk[s.id] = { role: s.is_supervisor ? 'Supervisor' : (s.relationship || 'Stakeholder'), supervisor: !!s.is_supervisor, baseline: null, d30: null, d90: null };
  for (const r of resp) {
    const row = byStk[r.stakeholder_id];
    if (row) row[cpKey(r.checkpoint)] = norm5(r.score, r.scale);
  }
  return Object.values(byStk);
}

async function buildEngagement(clientId) {
  const cks = await sbGet(`/rest/v1/checkins?client_id=eq.${enc(clientId)}&select=week_number,attended_coaching,completion_status`);
  if (!cks.length) return null;
  const weeks = cks.length;
  const weeksElapsed = Math.max(weeks, ...cks.map(c => c.week_number || 0));
  const practiced = cks.filter(c => c.completion_status === 'Yes').length;
  const attended = cks.filter(c => c.attended_coaching === true).length;

  // Coaching attendance denominator = sessions EXPECTED at this cadence, not weeks,
  // so an every-other-week client isn't penalized for off-weeks.
  const crows = await sbGet(`/rest/v1/clients?id=eq.${enc(clientId)}&select=coaching_cadence&limit=1`);
  const cadence = (crows && crows[0] && crows[0].coaching_cadence) || 'weekly';
  const everyN = cadence === 'monthly' ? 4 : (cadence === 'biweekly' ? 2 : 1);
  const expectedSessions = Math.max(1, Math.round(weeksElapsed / everyN));
  const coachingTotal = expectedSessions;
  const coachingAttended = Math.min(attended, coachingTotal);

  return {
    weeksElapsed,
    checkinRate: weeksElapsed ? Math.round((weeks / weeksElapsed) * 100) / 100 : 0,
    behaviorRate: weeks ? Math.round((practiced / weeks) * 100) / 100 : 0,
    coachingAttended,
    coachingTotal,
    cadence,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body  = req.body || {};
  const token = body.token;

  try {
    const sponsor = await sponsorByToken(token);
    if (!sponsor) return res.status(401).json({ error: 'Invalid or expired link' });
    // touch last-used (fire and forget)
    sb(`/rest/v1/sponsors?id=eq.${sponsor.id}`, 'PATCH', { token_last_used_at: new Date().toISOString() }, { Prefer: 'return=minimal' }).catch(() => {});

    // Teams this sponsor may see, with the per-engagement settings.
    const links = await sbGet(`/rest/v1/sponsor_teams?sponsor_id=eq.${enc(sponsor.id)}&select=*`);
    if (!links.length) return res.status(200).json({ ok: true, sponsor: { name: sponsor.name }, teams: [] });
    const teamIds = links.map(l => l.team_id);
    const teamRows = await sbGet(`/rest/v1/teams?id=in.(${teamIds.map(enc).join(',')})&active=eq.true&select=*`);

    // ── list-teams: the picker ────────────────────────────────────────────────
    if (body.action === 'list-teams') {
      const teams = teamRows.map(t => ({ id: t.id, name: t.name, client_org_name: t.client_org_name, team_type: t.team_type }));
      return res.status(200).json({ ok: true, sponsor: { name: sponsor.name }, teams });
    }

    // ── team: the full, scoped Decision Room payload ──────────────────────────
    if (body.action === 'team') {
      const teamId = body.team_id || teamRows[0] && teamRows[0].id;
      const link = links.find(l => l.team_id === teamId);
      const team = teamRows.find(t => t.id === teamId);
      if (!link || !team) return res.status(403).json({ error: 'Not authorized for this team' });

      // Coach preview mode: a valid coach session in the request forces standard view
      // regardless of the sponsor's actual confidentiality_mode. The sponsor's link
      // is completely unaffected — only the coach sees this override.
      const isCoachPreview = !!(body.coach_session && verifyCoachSession(body.coach_session));

      // Org logo (matched by organization name) — shown in the Decision Room header.
      let orgLogo = null;
      if (team.client_org_name) {
        try { const olr = await sbGet(`/rest/v1/organizations?name=eq.${enc(team.client_org_name)}&select=logo_url&limit=1`); if (olr && olr[0] && olr[0].logo_url) orgLogo = olr[0].logo_url; } catch (_) { /* optional */ }
      }

      const isPrivate = !isCoachPreview && link.confidentiality_mode === 'private';
      // 'progress' = staged view: the sponsor sees ONLY where each leader is in the
      // process, never results. Auto-reveal: a staged link opens to the full Decision
      // Room the day before the sponsor's own debrief (sponsor_debrief_date). The
      // manual reveal toggle (private/standard) still overrides at any time.
      let autoReveal = false;
      if (link.sponsor_debrief_date) {
        // Reveal on the day BEFORE the sponsor's debrief, by CALENDAR DATE in the org's
        // local timezone (ET). Anchor at noon UTC to dodge DST/rollover; compare YYYY-MM-DD
        // strings so we never reveal hours early off a UTC-parsed midnight.
        const dbd = new Date(link.sponsor_debrief_date + 'T12:00:00Z');
        if (!isNaN(dbd.getTime())) {
          dbd.setUTCDate(dbd.getUTCDate() - 1);
          const revealDate = dbd.toISOString().slice(0, 10);
          const todayET    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          autoReveal = todayET >= revealDate;
        }
      }
      const isProgress = !isCoachPreview && (link.confidentiality_mode === 'progress') && !autoReveal;
      const ownClientId = sponsor.linked_client_id || null;
      const supervises = Array.isArray(link.supervises_client_ids) ? link.supervises_client_ids
                       : (link.supervises_client_ids ? JSON.parse(link.supervises_client_ids) : []);

      const members = await teamMembers(teamId);

      // ── HARD FEEDBACK GATE (before assembling any team data) ───────────────
      const owed = await feedbackOwed(supervises, members);
      if (owed.length) {
        return res.status(200).json({
          ok: true, gated: true,
          team: { id: team.id, name: team.name, client_org_name: team.client_org_name, org_logo_url: orgLogo },
          owed: owed.map(o => ({ role: o.member, checkpoint: o.checkpoint,
            // deep-link to the EXISTING survey with the supervisor's existing token
            survey_url: `/diagnostic-survey?token=${enc(o.token)}` })),
        });
      }

      // ── assemble (already-scoped) ─────────────────────────────────────────
      // A 'progress' sponsor (coordinating POC) sees only WHERE each leader is in
      // the process — never another leader's scores, summary, succession, or 360.
      // They DO see their OWN full report, matched by the sponsor's linked client id.
      const memberReports = [];
      for (const m of members) {
        if (isProgress) {
          if (ownClientId && m.client_id === ownClientId) memberReports.push(await buildMemberReport(m, false));
          else memberReports.push(await buildMemberStatus(m));
        } else {
          memberReports.push(await buildMemberReport(m, isPrivate));
        }
      }

      // Results-level content (recommendations, signals, written team report) is
      // never assembled for a progress POC — they only get process status.
      // Omit the coach-only internal tags (gps_support_type, source_section) from the sponsor payload.
      const recsRaw = isProgress ? [] : await sbGet(`/rest/v1/recommendations?team_id=eq.${enc(teamId)}&status=eq.approved&visible_to_client=eq.true&select=short_title,description,owner,timeframe,category,target_band,quick_start_today,quick_start_week,updated_at&order=updated_at.desc`);
      const signalsRaw = isProgress ? [] : await sbGet(`/rest/v1/external_signals?team_id=eq.${enc(teamId)}&visible_to_client=eq.true&select=*&order=date_observed.desc`);

      // Written team report — the sponsor sees the coach-uploaded branded PDF,
      // never the draft text. Only when published (sponsor_visible) AND a PDF exists.
      const trRaw = isProgress ? null : await sbGet(`/rest/v1/diagnostic_team_reports?team_id=eq.${enc(teamId)}&sponsor_visible=eq.true&report_pdf_url=not.is.null&select=report_pdf_url,generated_at&order=generated_at.desc&limit=1`);
      const teamReport = (trRaw && trRaw[0]) ? { report_pdf_url: trRaw[0].report_pdf_url, generated_at: trRaw[0].generated_at } : null;

      // Sprint CTA — only in standard (fully revealed) mode.
      let sprintCtaUrl = null;
      if (!isProgress && !isPrivate) {
        try {
          const rc = await sbGet(`/rest/v1/renewal_config?id=eq.1&select=first_sprint_credit_url&limit=1`);
          sprintCtaUrl = (rc && rc[0] && rc[0].first_sprint_credit_url) || null;
          // Per-engagement override (custom_cta_url on the sponsor_teams row).
          if (link.custom_cta_url) sprintCtaUrl = link.custom_cta_url;
        } catch (_) { /* non-fatal */ }
      }

      return res.status(200).json({
        ok: true,
        sponsor: { name: sponsor.name },
        coach_preview: isCoachPreview || undefined,
        confidentiality: isCoachPreview ? 'standard' : link.confidentiality_mode,
        show_succession: link.show_succession_to_sponsor !== false,
        team: Object.assign({
          id: team.id, name: team.name, client_org_name: team.client_org_name, team_type: team.team_type,
          org_logo_url: orgLogo,
          primary_sponsor: sponsor.name,
        }, isProgress ? {} : {
          quick_read: team.quick_read, summary: team.summary, last_updated: team.last_updated,
          snapshot: team.snapshot, themes: team.themes,
          start_stop_continue: team.start_stop_continue, intent_impact: team.intent_impact,
        }),
        members: memberReports,
        recommendations: recsRaw,
        signals: signalsRaw,
        team_report: teamReport,
        sprint_cta_url: sprintCtaUrl,
      });
    }

    // ── Sponsor decision on a leader's 90-day plan ───────────────────────────
    // Scoped: the leader's client_id must belong to a team this sponsor is linked to.
    if (body.action === 'approve-plan' || body.action === 'request-changes') {
      const clientId = body.client_id;
      if (!clientId) return res.status(400).json({ error: 'client_id required' });
      let authorized = false;
      for (const tId of teamIds) {
        const tm = await sbGet(`/rest/v1/team_members?team_id=eq.${enc(tId)}&client_id=eq.${enc(clientId)}&select=id&limit=1`);
        if (tm && tm[0]) { authorized = true; break; }
      }
      if (!authorized) return res.status(403).json({ error: 'Not authorized for this leader' });
      const dr = await sbGet(`/rest/v1/diagnostics?client_id=eq.${enc(clientId)}&is_archived=eq.false&select=id&order=created_at.desc&limit=1`);
      const diag = dr && dr[0];
      if (!diag) return res.status(404).json({ error: 'No diagnostic for this leader' });
      const status = body.action === 'approve-plan' ? 'approved' : 'changes_requested';
      const note = (body.action === 'request-changes' && typeof body.note === 'string') ? body.note.trim().slice(0, 1000) : null;
      await sb(`/rest/v1/diagnostics?id=eq.${enc(diag.id)}`, 'PATCH',
        { plan_sponsor_status: status, plan_sponsor_decided_at: new Date().toISOString(), plan_sponsor_note: note, updated_at: new Date().toISOString() },
        { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true, status });
    }

    return res.status(400).json({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
