// api/pulse-schedule.js
// Shared helper: schedule recurring STAKEHOLDER PULSE sends into survey_schedules
// according to a client's cadence tier. Used by both survey.js (coach picker,
// action=schedule-pulses) and start-sprint.js (renewal / sprint 2+).
//
// Cadence tiers (clients.pulse_cadence_tier):
//   aggressive → 3 pulses  (day30 + day45 + day90)   — Sprint 1 window
//   light      → 2 pulses  (day45 + day90)           — renewal default
//   off        → 0 pulses  (leader-only)
//
// Outward labels are 30/45/90; internal send offsets are day 21/45/80 from the
// sprint anchor (sent ~1 week early to absorb response lag so reads land by the
// 30/90 marks). Any send that falls on a weekend is shifted to the next Monday,
// and the time of day is pinned to 13:00 UTC (9am ET) so pulses only go out on
// business days during working hours.
//
// This module never touches the `baseline` checkpoint — baseline is the coach's
// manual "before" send and is scheduled separately.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

// Outward checkpoint label → internal day offset from the sprint anchor date.
const PULSE_OFFSETS = { day30: 21, day45: 45, day90: 80 };

// Every pulse checkpoint this module manages, in send order.
const PULSE_CHECKPOINTS = ['day30', 'day45', 'day90'];

// Which checkpoints each tier schedules.
const TIER_CHECKPOINTS = {
  aggressive: ['day30', 'day45', 'day90'],
  light:      ['day45', 'day90'],
  off:        []
};

const SEND_HOUR_UTC = 13; // 9am ET (EDT, UTC-4) — a weekday business hour.

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

// Compute the send timestamp for a checkpoint: anchor + offset days, shifted off
// weekends to the following Monday, pinned to SEND_HOUR_UTC.
function businessDaySendTime(anchorDateStr, offsetDays) {
  const d = new Date(anchorDateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error('invalid anchor date: ' + anchorDateStr);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const dow = d.getUTCDay(); // 0 = Sun … 6 = Sat
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);      // Saturday → Monday
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1); // Sunday → Monday
  d.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);
  return d;
}

// Normalize a tier string to a known tier; default to 'light'.
function normalizeTier(tier) {
  const t = String(tier || '').toLowerCase().trim();
  return TIER_CHECKPOINTS[t] ? t : 'light';
}

// Schedule (or re-schedule) the pulse sends for one client's current sprint.
//   { client_id, tier, anchorDate, currentSprint }
// Idempotent: removes any UNSENT pulse schedules for day30/45/90 first, then
// re-inserts per tier. Checkpoints that have already been SENT for this sprint
// (survey_tokens exist) are left alone and not re-scheduled.
// Returns { tier, scheduled:[{checkpoint, scheduled_at}], skipped_already_sent:[...] }.
async function schedulePulses({ client_id, tier, anchorDate, currentSprint }) {
  if (!client_id) throw new Error('client_id required');
  const useTier   = normalizeTier(tier);
  const sprintNum = Number(currentSprint) || 1;
  const anchor    = anchorDate || new Date().toISOString().split('T')[0];

  // Which pulse checkpoints already went out this sprint? Don't re-send those.
  const sentRes = await sbFetch(
    `/rest/v1/survey_tokens?client_id=eq.${client_id}&sprint_number=eq.${sprintNum}&checkpoint=in.(day30,day45,day90)&select=checkpoint`
  );
  const sentRows = sentRes.ok ? await sentRes.json() : [];
  const alreadySent = new Set((sentRows || []).map(r => r.checkpoint));

  // Clear existing unsent pulse schedules so re-running is clean (never baseline).
  for (const cp of PULSE_CHECKPOINTS) {
    await sbFetch(
      `/rest/v1/survey_schedules?client_id=eq.${client_id}&checkpoint=eq.${cp}&sent_at=is.null`,
      'DELETE', null, { Prefer: 'return=minimal' }
    );
  }

  const wanted = TIER_CHECKPOINTS[useTier].filter(cp => !alreadySent.has(cp));
  const rows = wanted.map(cp => ({
    client_id,
    checkpoint:   cp,
    scheduled_at: businessDaySendTime(anchor, PULSE_OFFSETS[cp]).toISOString()
  }));

  let scheduled = [];
  if (rows.length) {
    const ins = await sbFetch('/rest/v1/survey_schedules', 'POST', rows, { Prefer: 'return=representation' });
    if (!ins.ok) {
      const t = await ins.text();
      throw new Error('survey_schedules insert failed: ' + t.slice(0, 200));
    }
    const out = await ins.json();
    scheduled = (out || []).map(r => ({ checkpoint: r.checkpoint, scheduled_at: r.scheduled_at }));
  }

  return {
    tier: useTier,
    scheduled,
    skipped_already_sent: [...alreadySent].filter(cp => TIER_CHECKPOINTS[useTier].includes(cp))
  };
}

// Cancel all remaining UNSENT pulse schedules for a client (used by auto-taper).
async function cancelRemainingPulses(client_id) {
  await sbFetch(
    `/rest/v1/survey_schedules?client_id=eq.${client_id}&checkpoint=in.(day30,day45,day90)&sent_at=is.null`,
    'DELETE', null, { Prefer: 'return=minimal' }
  );
}

module.exports = {
  schedulePulses,
  cancelRemainingPulses,
  businessDaySendTime,
  normalizeTier,
  PULSE_OFFSETS,
  PULSE_CHECKPOINTS,
  TIER_CHECKPOINTS
};
