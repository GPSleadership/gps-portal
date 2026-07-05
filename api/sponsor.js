// GPS Leadership — Sponsor Follow-Along API (roadmap #4)
//
// THE SECURITY BOUNDARY for the single-leader coaching sponsor page
// (sponsor.html / /sponsor). Modeled on api/sponsor-data.js and api/diag-portal.js.
//
// A coaching sponsor row (public.sponsors, linked_client_id set by the Activate
// 90-Day Sprint flow) carries a sponsor_token. This endpoint validates that token
// with the service-role key and returns a FULLY-ASSEMBLED, already-scoped payload
// for the ONE leader that sponsor supports. The browser never touches Supabase.
//
// HARD CONFIDENTIALITY WALL: this endpoint only ever reads aggregate scores,
// counts, plan fields, and coach-authored text. It NEVER fetches or returns
// leader check-in text, private reflections, barriers, Ask Alex history, or any
// attributed rater comment. The wall is enforced here (in what we SELECT), not
// client-side and not via RLS (the service role bypasses RLS).
//
// POST /api/sponsor  { action, token, coach_session? }
//   action = 'get'
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

const enc = encodeURIComponent;
const crypto = require('crypto');

// Coach preview: a valid coach session forces the fully-revealed ('summary') view
// regardless of the sponsor's saved mode. Matches signSession in get-client.js.
function verifyCoachSession(tok) {
  if (!tok || !COACH_SESSION_SECRET) return false;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

async function sponsorByToken(token) {
  if (!token) return null;
  const rows = await sbGet(`/rest/v1/sponsors?sponsor_token=eq.${enc(token)}&active=eq.true&limit=1`);
  return rows[0] || null;
}

// Normalize any survey score to a 1-5 value by its OWN scale (matches sponsor-data.js).
function norm5(score, scale) {
  if (score == null) return null;
  const s = Number(scale) || 5;
  return Math.round((Number(score) / s * 5) * 100) / 100;
}
// Map 90-day survey checkpoint labels to baseline / d30 / d90.
function cpKey(checkpoint) {
  const c = String(checkpoint || '').toLowerCase();
  if (c.includes('90')) return 'd90';
  if (c.includes('45') || c.includes('30')) return 'd30';
  return 'baseline';
}
function avgOf(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + Number(b), 0) / v.length) * 100) / 100;
}

// HERO — aggregate stakeholder pulse trend (Day 1 / 30 / 90), DIRECTION ONLY,
// with min-N suppression. Fewer than 3 responding raters => "pulse pending"
// (never expose a trend that could de-anonymize a single rater). Returns only
// aggregate averages + a direction word — never a per-rater or attributed value.
async function buildPulse(clientId) {
  const stks = await sbGet(`/rest/v1/stakeholders?client_id=eq.${enc(clientId)}&is_active=eq.true&select=id`);
  if (!stks.length) return { status: 'pending', raterCount: 0 };
  const resp = await sbGet(`/rest/v1/survey_responses?client_id=eq.${enc(clientId)}&select=stakeholder_id,checkpoint,score,scale`);
  const byStk = {};
  for (const s of stks) byStk[s.id] = { baseline: null, d30: null, d90: null };
  for (const r of resp) {
    const row = byStk[r.stakeholder_id];
    if (row) row[cpKey(r.checkpoint)] = norm5(r.score, r.scale);
  }
  const rows = Object.values(byStk);
  // Raters who have contributed ANY pulse value.
  const responding = rows.filter(r => r.baseline != null || r.d30 != null || r.d90 != null);
  if (responding.length < 3) return { status: 'pending', raterCount: responding.length };

  const baseline = avgOf(rows.map(r => r.baseline));
  const mid      = avgOf(rows.map(r => r.d30));
  const latest90 = avgOf(rows.map(r => r.d90));
  const latest   = latest90 != null ? latest90 : mid;
  let direction = 'steady';
  if (baseline != null && latest != null) {
    if (latest >= baseline + 0.15) direction = 'improving';
    else if (latest <= baseline - 0.15) direction = 'slipping';
  }
  return {
    status: 'ready',
    raterCount: responding.length,
    baseline, mid, latest,
    direction,
    points: [
      { label: 'Day 1',  value: baseline },
      { label: 'Day 30', value: mid },
      { label: 'Day 90', value: latest90 },
    ].filter(p => p.value != null),
  };
}

// Engagement signal — check-in rhythm only (counts, never content). Used to set
// the On Track / Needs Attention chip. Reads no free text.
async function buildCheckinRhythm(clientId) {
  const cks = await sbGet(`/rest/v1/checkins?client_id=eq.${enc(clientId)}&select=week_number,completion_status`);
  if (!cks.length) return { weeks: 0, checkinRate: null };
  const weeks = cks.length;
  const weeksElapsed = Math.max(weeks, ...cks.map(c => c.week_number || 0));
  return {
    weeks,
    weeksElapsed,
    checkinRate: weeksElapsed ? Math.round((weeks / weeksElapsed) * 100) / 100 : null,
  };
}

// If the sponsor is ALSO a stakeholder who rated this leader, return THEIR OWN
// ratings + THEIR OWN comment across checkpoints — a reminder of what they
// observed, next to the aggregate. This is the sponsor's own data, so it does
// not touch the confidentiality wall. Strict identity match only: exactly ONE
// active stakeholder for this leader whose email equals the sponsor's email
// (case-insensitive). Zero or multiple matches => return null (never guess —
// a wrong match would leak another rater's data).
async function buildSponsorOwnRatings(sponsor, clientId) {
  const email = String(sponsor.email || '').trim().toLowerCase();
  if (!email) return null;
  const stks = await sbGet(`/rest/v1/stakeholders?client_id=eq.${enc(clientId)}&is_active=eq.true&select=id,email,relationship`);
  const matches = stks.filter(s => String(s.email || '').trim().toLowerCase() === email);
  if (matches.length !== 1) return null;
  const stk = matches[0];
  const resp = await sbGet(`/rest/v1/survey_responses?stakeholder_id=eq.${enc(stk.id)}&select=checkpoint,score,scale,comments,open_response,submitted_at&order=submitted_at.asc`);
  if (!resp.length) return null;
  const byCp = { baseline: null, d30: null, d90: null };
  let latestComment = null;
  for (const r of resp) {
    byCp[cpKey(r.checkpoint)] = norm5(r.score, r.scale);
    const t = String(r.comments || r.open_response || '').trim();
    if (t) latestComment = t;   // most recent non-empty (rows are ordered asc)
  }
  const points = [
    { label: 'Day 1',  value: byCp.baseline },
    { label: 'Day 30', value: byCp.d30 },
    { label: 'Day 90', value: byCp.d90 },
  ].filter(p => p.value != null);
  if (!points.length && !latestComment) return null;
  return { relationship: stk.relationship || null, points, comment: latestComment };
}

// The agreed recommendations the sponsor selected during plan approval, tracked
// through the engagement. Sponsor-safe: these are the coach-authored items the
// sponsor already chose, plus the coach's comment and completion state. The
// sponsor may only COMPLETE items where they own the action (responsible_party
// = 'sponsor'); leader/coach items are the coach's ground truth (read-only here).
async function buildRecommendations(clientId) {
  const rows = await sbGet(`/rest/v1/recommendations?client_id=eq.${enc(clientId)}&status=eq.approved&select=id,short_title,description,timeframe,responsible_party,coach_comment,completed_at,completed_by,sort_order,created_at&order=sort_order.asc.nullslast,created_at.asc`);
  if (!rows || !rows.length) return null;
  return rows.map(r => ({
    id: r.id,
    title: r.short_title || null,
    description: r.description || null,
    timeframe: r.timeframe || null,
    owner: r.responsible_party || null,                 // 'sponsor' | 'leader' | 'coach' | null
    coach_comment: r.coach_comment || null,
    completed: !!r.completed_at,
    completed_by: r.completed_by || null,
    can_sponsor_complete: r.responsible_party === 'sponsor',
  }));
}

// The sponsor's FULL authorized leader set: the legacy single link
// (linked_client_id) UNION the sponsor_leaders join rows (v86, multi-leader).
// This is the ONLY source of truth for which leaders this token may see — every
// data read and rec completion is gated against it.
async function resolveLeaderIds(sponsor) {
  const ids = [];
  if (sponsor.linked_client_id) ids.push(sponsor.linked_client_id);
  const rows = await sbGet(`/rest/v1/sponsor_leaders?sponsor_id=eq.${enc(sponsor.id)}&select=client_id`);
  for (const r of rows) if (r.client_id && !ids.includes(r.client_id)) ids.push(r.client_id);
  return ids;
}

// One light card for the roster (multi-leader sponsors). Name + org + a single
// engagement chip + sprint end — no metric values, no reflections. Leaders whose
// coaching isn't active yet are still listed, flagged not_coaching.
async function buildRosterCard(clientId) {
  const cRows = await sbGet(`/rest/v1/clients?id=eq.${enc(clientId)}&select=name,organization,org,in_coaching_program,is_active_coaching,coaching_sessions_enabled,coaching_program_end_date&limit=1`);
  const c = cRows[0];
  if (!c) return null;
  const firstName = String(c.name || '').trim().split(/\s+/)[0] || 'Leader';
  const fullName = String(c.name || '').trim() || firstName;
  const orgName = c.organization || c.org || null;
  const coachingActive = !!(c.in_coaching_program || c.is_active_coaching || c.coaching_sessions_enabled);
  let chip = 'on_track';
  if (coachingActive) {
    const [pulse, rhythm] = await Promise.all([buildPulse(clientId), buildCheckinRhythm(clientId)]);
    if (pulse.status === 'ready' && pulse.direction === 'slipping') chip = 'needs_attention';
    else if (rhythm.checkinRate != null && rhythm.weeksElapsed >= 3 && rhythm.checkinRate < 0.5) chip = 'needs_attention';
  }
  return {
    leader_id: clientId,
    first_name: firstName,
    full_name: fullName,
    org_name: orgName,
    chip,
    not_coaching: !coachingActive,
    sprint_end_date: c.coaching_program_end_date || null,
  };
}

// Build the full single-leader follow-along payload (the existing sponsor view)
// for ONE authorized leader. Returns { not_coaching } holding state if their
// coaching isn't active yet, else the assembled payload. Confidentiality wall
// unchanged: only aggregate/plan/coach-authored fields are ever read.
async function buildLeaderView(sponsor, clientId, isCoachPreview) {
  const mode = isCoachPreview ? 'summary' : (sponsor.confidentiality_mode || 'summary');
  const cRows = await sbGet(`/rest/v1/clients?id=eq.${enc(clientId)}&select=name,organization,org,in_coaching_program,is_active_coaching,coaching_sessions_enabled,goal_statement,goal_description,goal_30_day,behavior_1,behavior_2,coaching_sessions_total,coaching_sessions_completed,coaching_program_end_date&limit=1`);
  const c = cRows[0];
  if (!c) return { error: 'Leader not found', status: 404 };

  const firstName = String(c.name || '').trim().split(/\s+/)[0] || 'Your leader';
  let orgLogo = null;
  const orgName = c.organization || c.org || null;
  if (orgName) {
    try {
      const olr = await sbGet(`/rest/v1/organizations?name=eq.${enc(orgName)}&select=logo_url&limit=1`);
      if (olr[0] && olr[0].logo_url) orgLogo = olr[0].logo_url;
    } catch (_) { /* logo optional */ }
  }

  const coachingActive = !!(c.in_coaching_program || c.is_active_coaching || c.coaching_sessions_enabled);
  if (!coachingActive) {
    return {
      payload: {
        ok: true,
        not_coaching: true,
        header: { leader_first_name: firstName, sponsor_name: sponsor.name || null, org_name: orgName || null, org_logo_url: orgLogo || null },
      },
    };
  }

  const [pulse, rhythm, ownRatings, recommendations] = await Promise.all([
    buildPulse(clientId), buildCheckinRhythm(clientId), buildSponsorOwnRatings(sponsor, clientId), buildRecommendations(clientId),
  ]);

  let chip = 'on_track';
  if (pulse.status === 'ready' && pulse.direction === 'slipping') chip = 'needs_attention';
  else if (rhythm.checkinRate != null && rhythm.weeksElapsed >= 3 && rhythm.checkinRate < 0.5) chip = 'needs_attention';

  let consistency = null;
  if (rhythm.weeksElapsed >= 1 && rhythm.weeks > 0) {
    const engaged = Math.min(rhythm.weeks, rhythm.weeksElapsed);
    const rate = engaged / rhythm.weeksElapsed;
    let label = 'Consistent';
    if (rate < 0.5) label = 'Uneven';
    else if (rate < 0.8) label = 'Steady';
    consistency = { weeks_engaged: engaged, weeks_elapsed: rhythm.weeksElapsed, label };
  }

  const sessionsTotal     = (c.coaching_sessions_total != null) ? Number(c.coaching_sessions_total) : null;
  const sessionsCompleted = (c.coaching_sessions_completed != null) ? Number(c.coaching_sessions_completed) : null;

  const payload = {
    ok: true,
    coach_preview: isCoachPreview || undefined,
    confidentiality_mode: mode,
    header: { leader_first_name: firstName, sponsor_name: sponsor.name || null, org_name: orgName || null, org_logo_url: orgLogo || null },
    pulse,
    your_ratings: ownRatings || undefined,
    engagement: {
      chip,
      sessions_total: sessionsTotal,
      sessions_completed: sessionsCompleted,
      cadence_note: 'checking in weekly',
      consistency,
    },
    coach_summary: sponsor.coach_summary || null,
    sponsor_actions: sponsor.sponsor_actions || null,
    recommendations: recommendations || undefined,
    sprint_end_date: c.coaching_program_end_date || null,
  };
  if (mode === 'summary') {
    const goal = c.goal_statement || c.goal_description || c.goal_30_day || null;
    payload.focus = { goal, behaviors: [c.behavior_1, c.behavior_2].filter(Boolean) };
  }
  return { payload };
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

    if (body.action && body.action !== 'get' && body.action !== 'complete-rec') {
      return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }

    // The sponsor's authorized leaders (single link + multi-leader join rows).
    const leaderIds = await resolveLeaderIds(sponsor);
    // No leaders = a team/Decision-Room sponsor, not a coaching sponsor.
    if (!leaderIds.length) return res.status(200).json({ ok: true, unlinked: true, sponsor: { name: sponsor.name } });

    const isCoachPreview = !!(body.coach_session && verifyCoachSession(body.coach_session));

    // ── Sponsor completes ONE of their OWN recommendations ─────────────────
    // Ground-truth lock: only items they own (responsible_party = 'sponsor') on a
    // leader they're authorized to follow. Leader/coach items are the coach's.
    if (body.action === 'complete-rec') {
      const recId = String(body.rec_id || '');
      if (!recId) return res.status(400).json({ error: 'rec_id required' });
      const recRows = await sbGet(`/rest/v1/recommendations?id=eq.${enc(recId)}&select=id,client_id,responsible_party,status,completed_at&limit=1`);
      const rec = recRows[0];
      if (!rec || !leaderIds.includes(rec.client_id)) return res.status(404).json({ error: 'Recommendation not found' });
      if (rec.responsible_party !== 'sponsor') {
        return res.status(403).json({ error: "Your coach marks this one complete — it's on the leader's side." });
      }
      const done = body.completed === true;
      const upd = done
        ? { completed_at: new Date().toISOString(), completed_by: 'sponsor' }
        : { completed_at: null, completed_by: null };
      await sb(`/rest/v1/recommendations?id=eq.${enc(recId)}`, 'PATCH', upd, { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true, completed: done });
    }

    // Pick the leader to view. An explicit leader_id must be in the authorized
    // set (never trust a client-supplied id otherwise). With multiple leaders and
    // no selection, return the ROSTER so the sponsor can drill in.
    let targetId = body.leader_id ? String(body.leader_id) : null;
    if (targetId && !leaderIds.includes(targetId)) return res.status(403).json({ error: 'Not authorized for that leader' });
    if (!targetId && leaderIds.length === 1) targetId = leaderIds[0];

    if (!targetId) {
      const cards = (await Promise.all(leaderIds.map(id => buildRosterCard(id)))).filter(Boolean);
      return res.status(200).json({
        ok: true,
        roster: cards,
        header: { sponsor_name: sponsor.name || null },
      });
    }

    const view = await buildLeaderView(sponsor, targetId, isCoachPreview);
    if (view.error) return res.status(view.status || 500).json({ error: view.error });
    // Tell the page it can offer a "back to all leaders" affordance.
    if (leaderIds.length > 1) { view.payload.multi = true; view.payload.roster_count = leaderIds.length; }
    return res.status(200).json(view.payload);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
