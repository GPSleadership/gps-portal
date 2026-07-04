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

    if (body.action && body.action !== 'get') {
      return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }

    const clientId = sponsor.linked_client_id || null;
    // A sponsor with no linked leader is a team/Decision-Room sponsor, not a
    // single-leader coaching sponsor. Signal the page to point them elsewhere.
    if (!clientId) return res.status(200).json({ ok: true, unlinked: true, sponsor: { name: sponsor.name } });

    // Coach preview forces the fully-revealed view; otherwise honor the saved mode.
    const isCoachPreview = !!(body.coach_session && verifyCoachSession(body.coach_session));
    const mode = isCoachPreview ? 'summary' : (sponsor.confidentiality_mode || 'summary');

    // The ONLY leader fields that may reach a sponsor: identity, the shared plan
    // (goal + priority behaviors), session counts, program end. No reflections,
    // no metrics values, no check-in text.
    const cRows = await sbGet(`/rest/v1/clients?id=eq.${enc(clientId)}&select=name,organization,org,in_coaching_program,is_active_coaching,coaching_sessions_enabled,goal_statement,goal_description,goal_30_day,behavior_1,behavior_2,coaching_sessions_total,coaching_sessions_completed,coaching_program_end_date&limit=1`);
    const c = cRows[0];
    if (!c) return res.status(404).json({ error: 'Leader not found' });

    const firstName = String(c.name || '').trim().split(/\s+/)[0] || 'Your leader';

    // Client org logo (matched by organization name) — shown in the header, same as
    // the diagnostic and Decision Room pages. Best-effort; never blocks the page.
    let orgLogo = null;
    const orgName = c.organization || c.org || null;
    if (orgName) {
      try {
        const olr = await sbGet(`/rest/v1/organizations?name=eq.${enc(orgName)}&select=logo_url&limit=1`);
        if (olr[0] && olr[0].logo_url) orgLogo = olr[0].logo_url;
      } catch (_) { /* logo optional */ }
    }

    // COACHING-ONLY GATE: the follow-along view (pulse, sessions, coach notes) only
    // makes sense once an active coaching relationship exists. Before that, the same
    // link shows a calm holding state (and, in Phase 3, the diagnostic timeline +
    // report at the pre-brief). We never render an empty follow-along.
    const coachingActive = !!(c.in_coaching_program || c.is_active_coaching || c.coaching_sessions_enabled);
    if (!coachingActive) {
      return res.status(200).json({
        ok: true,
        not_coaching: true,
        header: { leader_first_name: firstName, sponsor_name: sponsor.name || null, org_name: orgName || null, org_logo_url: orgLogo || null },
      });
    }

    const [pulse, rhythm, ownRatings] = await Promise.all([
      buildPulse(clientId), buildCheckinRhythm(clientId), buildSponsorOwnRatings(sponsor, clientId),
    ]);

    // Engagement chip — calm default. Needs Attention only on a real negative signal
    // (pulse slipping or a check-in rhythm that has clearly lapsed). Otherwise On Track.
    let chip = 'on_track';
    if (pulse.status === 'ready' && pulse.direction === 'slipping') chip = 'needs_attention';
    else if (rhythm.checkinRate != null && rhythm.weeksElapsed >= 3 && rhythm.checkinRate < 0.5) chip = 'needs_attention';

    // Weekly consistency SIGNAL — whether the leader is showing up and doing the
    // work each week. A behavioral signal only: counts of engaged weeks + a
    // qualitative label. NEVER the self-metric's values or any reflection text.
    // Most useful early, while the stakeholder pulse is still below min-N ("pending").
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
      header: {
        leader_first_name: firstName,
        sponsor_name: sponsor.name || null,
        org_name: orgName || null,
        org_logo_url: orgLogo || null,
      },
      pulse,                                   // hero: aggregate direction, min-N suppressed
      your_ratings: ownRatings || undefined,   // sponsor's OWN ratings/comment (their data), if matched
      engagement: {
        chip,                                  // 'on_track' | 'needs_attention'
        sessions_total: sessionsTotal,         // COUNT only — never a "sessions remaining" meter
        sessions_completed: sessionsCompleted,
        cadence_note: 'checking in weekly',
        consistency,                           // behavioral signal only (weeks engaged + label)
      },
      coach_summary: sponsor.coach_summary || null,     // coach-authored
      sponsor_actions: sponsor.sponsor_actions || null, // coach-authored "how you can help"
      sprint_end_date: c.coaching_program_end_date || null,
    };

    // Shared plan (goal + priority behaviors) — shown in the full 'summary' view.
    // 'outcomes_only' trims to the trend + coach-authored notes.
    if (mode === 'summary') {
      const goal = c.goal_statement || c.goal_description || c.goal_30_day || null;
      payload.focus = {
        goal,
        behaviors: [c.behavior_1, c.behavior_2].filter(Boolean),
      };
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
