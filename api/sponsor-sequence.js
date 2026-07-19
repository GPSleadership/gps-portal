// api/sponsor-sequence.js
// Consolidated sponsor pre-debrief. A sponsor with several leaders gets ONE roster
// email listing every leader and their debrief date, scheduled the morning before the
// earliest debrief -- instead of one "heads up" per leader. Idempotent: rebuilds the
// single sponsor-level email_drafts row (sponsor_id set, diagnostic_id NULL) whenever a
// debrief date moves or a new person under that sponsor is added.
//
// The sponsor's OWN diagnostic is excluded by email match (a sponsor who is also a leader
// should not appear on their own roster).
//
// Auth: Vercel cron header, or Bearer CRON_SECRET (manual/cron), or a coach session in the
// body (manual "re-sync" from coach.html). No anon access.
//
//   POST { sponsor_id, session }   -> rebuild one sponsor's roster (coach or cron)
//   POST { all: true }             -> rebuild every active sponsor (cron sweep)
//
// This endpoint only WRITES the scheduled row. The existing diagnostic send loop
// (status='scheduled', scheduled_for<=now) delivers it, so no send-side change is needed.

import crypto from 'node:crypto';

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const CRON_SECRET     = process.env.CRON_SECRET || '';
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const PORTAL_ORIGIN   = process.env.PORTAL_BASE_URL || 'https://portal.gpsleadership.org';

const EMAIL_KEY = 'sponsor_pre_roster';

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const enc = encodeURIComponent;

// Same HMAC coach-session check the other endpoints use (manual re-sync path).
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

// ET "today" as YYYY-MM-DD so we keep only upcoming debriefs regardless of server TZ.
function etToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// "Tuesday, July 21" style, matching the existing sequence copy.
function fmtDebrief(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
// Day before the given date at 14:00 UTC (= 10am ET during EDT), matching the E-sequence hour.
function scheduleDayBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1, 14, 0, 0)).toISOString();
}

function buildRosterEmail(sponsorFirst, roster) {
  const lines = roster.map(r => '- ' + r.name + ': ' + fmtDebrief(r.debrief_date)).join('\n');
  const subject = "Your team's upcoming debriefs";
  const body =
    'Hi ' + (sponsorFirst || 'there') + ',\n\n' +
    'Quick heads up on the diagnostic debriefs coming up for your team. Each one is where we go through that leader\'s findings together and identify their key development focus for the next 90 days. These are focused working sessions, not general reviews.\n\n' +
    'Here is the schedule:\n\n' +
    lines + '\n\n' +
    'Once I have met with each of them, you and I will have our own conversation to walk through what came out of the debriefs and what your role looks like heading into the next phase. I will reach out to set that up.\n\n' +
    'Any questions before then, just reply here.';
  return { subject, body };
}

// Statuses that mean "this diagnostic is real and heading to a debrief".
const ACTIVE_STATUSES = ['survey_closed', 'report_preview', 'report_draft', 'report_final', 'debriefed'];

async function loadRoster(sponsor) {
  // sponsor -> teams -> members -> diagnostics
  const stR = await sb(`/rest/v1/sponsor_teams?sponsor_id=eq.${enc(sponsor.id)}&select=team_id`);
  const teamIds = (stR.ok ? await stR.json() : []).map(r => r.team_id).filter(Boolean);
  if (!teamIds.length) return [];
  const tmR = await sb(`/rest/v1/team_members?team_id=in.(${teamIds.map(enc).join(',')})&select=client_id`);
  const clientIds = (tmR.ok ? await tmR.json() : []).map(r => r.client_id).filter(Boolean);
  if (!clientIds.length) return [];
  const today = etToday();
  const dR = await sb(`/rest/v1/diagnostics?client_id=in.(${clientIds.map(enc).join(',')})&debrief_date=gte.${today}&select=client_name,client_email,debrief_date,status`);
  const diags = dR.ok ? await dR.json() : [];
  const sponsorEmail = String(sponsor.email || '').toLowerCase();
  return (Array.isArray(diags) ? diags : [])
    .filter(d => d.debrief_date)
    .filter(d => ACTIVE_STATUSES.indexOf(d.status) >= 0)
    .filter(d => String(d.client_email || '').toLowerCase() !== sponsorEmail) // exclude the sponsor's own diagnostic
    .map(d => ({ name: d.client_name || 'A leader', debrief_date: d.debrief_date }))
    .sort((a, b) => a.debrief_date < b.debrief_date ? -1 : a.debrief_date > b.debrief_date ? 1 : (a.name < b.name ? -1 : 1));
}

async function rebuildForSponsor(sponsorId) {
  const spR = await sb(`/rest/v1/sponsors?id=eq.${enc(sponsorId)}&select=id,name,email,sponsor_token&limit=1`);
  const sponsor = (spR.ok ? await spR.json() : [])[0];
  if (!sponsor || !sponsor.email) return { sponsor_id: sponsorId, skipped: 'no sponsor email' };

  const roster = await loadRoster(sponsor);

  // Find the existing consolidated row (if any).
  const exR = await sb(`/rest/v1/email_drafts?sponsor_id=eq.${enc(sponsorId)}&email_key=eq.${EMAIL_KEY}&diagnostic_id=is.null&select=id,status&limit=1`);
  const existing = (exR.ok ? await exR.json() : [])[0] || null;

  // Nothing to send to this sponsor: clean up a not-yet-sent row, leave sent history alone.
  if (!roster.length) {
    if (existing && existing.status !== 'sent') {
      await sb(`/rest/v1/email_drafts?id=eq.${enc(existing.id)}`, 'DELETE');
    }
    return { sponsor_id: sponsorId, roster: 0, action: existing && existing.status !== 'sent' ? 'removed' : 'none' };
  }

  // Already delivered once -> do not rebuild/re-send. (A new cycle would use a fresh key.)
  if (existing && existing.status === 'sent') {
    return { sponsor_id: sponsorId, roster: roster.length, action: 'already_sent' };
  }

  const now = new Date().toISOString();
  const sponsorFirst = String(sponsor.name || '').trim().split(/\s+/)[0] || '';
  const { subject, body } = buildRosterEmail(sponsorFirst, roster);
  const scheduledFor = scheduleDayBefore(roster[0].debrief_date);

  const payload = {
    sponsor_id: sponsorId,
    diagnostic_id: null,
    email_key: EMAIL_KEY,
    sequence: 'sponsor',
    subject,
    body,
    roster,
    to_name: sponsor.name || '',
    to_email: sponsor.email,
    scheduled_for: scheduledFor,
    status: 'scheduled',
    updated_at: now,
  };

  if (existing) {
    await sb(`/rest/v1/email_drafts?id=eq.${enc(existing.id)}`, 'PATCH', payload, { Prefer: 'return=minimal' });
    return { sponsor_id: sponsorId, roster: roster.length, action: 'updated', scheduled_for: scheduledFor };
  }
  await sb('/rest/v1/email_drafts', 'POST', { ...payload, created_at: now }, { Prefer: 'return=minimal' });
  return { sponsor_id: sponsorId, roster: roster.length, action: 'created', scheduled_for: scheduledFor };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', PORTAL_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server not configured' });
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret    = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
  const isCoach      = !!verifyCoachSession(body.session);
  if (!isVercelCron && !hasSecret && !isCoach) return res.status(401).json({ error: 'Unauthorized' });

  // Vercel cron fires as GET with no body -> treat as the full sweep.
  const wantsSweep = body.all === true || (req.method === 'GET' && (isVercelCron || hasSecret));

  try {
    // Sweep: rebuild every active sponsor (cron only).
    if (wantsSweep) {
      if (!isVercelCron && !hasSecret) return res.status(403).json({ error: 'Sweep requires cron auth' });
      const spR = await sb('/rest/v1/sponsors?select=id&order=created_at.asc');
      const sponsors = spR.ok ? await spR.json() : [];
      const results = [];
      for (const s of (Array.isArray(sponsors) ? sponsors : [])) {
        try { results.push(await rebuildForSponsor(s.id)); }
        catch (e) { results.push({ sponsor_id: s.id, error: e.message }); }
      }
      const built = results.filter(r => r.action === 'created' || r.action === 'updated').length;
      return res.status(200).json({ ok: true, sponsors: results.length, built, results });
    }

    // Single sponsor rebuild (coach re-sync or targeted cron).
    if (!body.sponsor_id) return res.status(400).json({ error: 'sponsor_id required (or { all: true } for the sweep)' });
    const result = await rebuildForSponsor(String(body.sponsor_id));
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[sponsor-sequence]', e);
    return res.status(500).json({ error: e.message });
  }
}
