// api/activate-sprint.js
// Project #1 — "Activate 90-Day Sprint".
// One atomic coach action that converts a debriefed diagnostic client into an
// active coaching engagement:
//   • sets coaching flags + program start/end dates
//   • creates the Sprint 1 record
//   • sets the stakeholder-pulse cadence to Aggressive and schedules the pulses
//     (reuses the Stage 3 scheduler in ./pulse-schedule) + a baseline send now
//   • creates/links the sponsor row + follow-along token (sponsored engagements)
//   • stamps welcome_sent_at + welcome_variant as the double-activate guard
// It does NOT send the welcome email itself — it returns the payload so coach.html
// fires notify.js `coaching_activation_welcome` (same pattern as markDebriefComplete),
// which means a failed email can be retried without re-running activation.

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const SITE_URL        = process.env.SITE_URL || 'https://portal.gpsleadership.org';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const b = req.body || {};
    const { client_id, diagnostic_id, start_date, end_date,
            sponsored, sponsor_name, sponsor_email, force, password } = b;

    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    // Auth: coach session (preferred) or legacy password.
    const authOk = !!verifyCoachSession(b.session) || await verifyPassword(password);
    if (!authOk) return res.status(401).json({ error: 'Not authorized' });

    // ── Load client ───────────────────────────────────────────────────────────
    const clientRes = await sbFetch(
      `/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}&select=id,name,email,token,behavior_1,start_behavior,observable_measure,current_sprint_number,welcome_sent_at,goal_statement`
    );
    if (!clientRes.ok) return res.status(500).json({ error: 'Failed to load client' });
    const clients = await clientRes.json();
    if (!clients || clients.length === 0) return res.status(404).json({ error: 'Client not found' });
    const client = clients[0];

    // ── Guard: don't double-activate ───────────────────────────────────────────
    if (client.welcome_sent_at && !force) {
      return res.status(409).json({
        error: 'already_activated',
        message: 'This client was already activated. Re-send the welcome from the client page instead, or pass force to re-activate.'
      });
    }

    const today       = new Date().toISOString().split('T')[0];
    const startDate   = start_date || today;
    const endDate     = end_date || addDaysISO(startDate, 90);
    const sprintNum   = client.current_sprint_number || 1;
    const priorityBehavior = (client.observable_measure || client.behavior_1 || client.start_behavior || '').trim();

    // ── 1. Turn on coaching + program dates ────────────────────────────────────
    const patchRes = await sbFetch(
      `/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}`,
      'PATCH',
      {
        in_coaching_program:        true,
        is_active_coaching:         true,
        coaching_sessions_enabled:  true,
        coaching_program_start_date: startDate,
        coaching_program_end_date:   endDate,
        current_sprint_number:       sprintNum,
        pulse_cadence_tier:          'aggressive',
        pulse_tapered_at:            null
      },
      { Prefer: 'return=minimal' }
    );
    if (!patchRes.ok) {
      const t = await patchRes.text();
      return res.status(500).json({ error: 'Failed to activate coaching', detail: t.slice(0, 200) });
    }

    // ── 2. Ensure a Sprint 1 record exists ─────────────────────────────────────
    const sprintCheck = await sbFetch(
      `/rest/v1/sprints?client_id=eq.${encodeURIComponent(client_id)}&sprint_number=eq.${sprintNum}&select=id`
    );
    const existingSprints = sprintCheck.ok ? await sprintCheck.json() : [];
    if (!existingSprints || existingSprints.length === 0) {
      await sbFetch('/rest/v1/sprints', 'POST', {
        client_id,
        sprint_number:  sprintNum,
        start_date:     startDate,
        behavior_focus: priorityBehavior || null,
        status:         'active'
      }, { Prefer: 'return=minimal' });
    }

    // ── 3. Schedule the pulse cadence + a baseline send ────────────────────────
    let pulseResult = { scheduled: [] };
    try {
      const { schedulePulses } = require('./pulse-schedule');
      pulseResult = await schedulePulses({
        client_id, tier: 'aggressive', anchorDate: startDate, currentSprint: sprintNum
      });
    } catch (e) {
      // non-fatal: coach can re-apply cadence from the picker
      console.error('activate-sprint: pulse scheduling failed:', e && e.message);
    }

    // Baseline goes out now (via the every-15-min survey cron) only if there's a
    // behavior for stakeholders to rate. If not, it's deferred until the coach sets
    // the observable measure / the leader completes their plan.
    // Only queue a baseline if there's a behavior AND active stakeholders to rate
    // it — otherwise the send would fail and retry forever (the audit's known trap).
    let baselineDeferred = true;
    if (priorityBehavior) {
      const shRes = await sbFetch(`/rest/v1/stakeholders?client_id=eq.${encodeURIComponent(client_id)}&is_active=eq.true&select=id&limit=1`);
      const hasStakeholders = shRes.ok && ((await shRes.json()) || []).length > 0;
      if (hasStakeholders) {
        await sbFetch(
          `/rest/v1/survey_schedules?client_id=eq.${encodeURIComponent(client_id)}&checkpoint=eq.baseline&sent_at=is.null`,
          'DELETE', null, { Prefer: 'return=minimal' }
        );
        const bins = await sbFetch('/rest/v1/survey_schedules', 'POST', {
          client_id, checkpoint: 'baseline', scheduled_at: new Date().toISOString()
        }, { Prefer: 'return=minimal' });
        baselineDeferred = !bins.ok;
      }
    }

    // ── 4. Sponsor row + follow-along token (sponsored engagements) ─────────────
    let sponsorFollowLink = null;
    let finalSponsorName = null, finalSponsorEmail = null;
    const isSponsored = !!sponsored && !!sponsor_email;
    if (isSponsored) {
      finalSponsorName  = sponsor_name || '';
      finalSponsorEmail = sponsor_email;
      // Find an existing sponsor for this client + email, else create one.
      const spRes = await sbFetch(
        `/rest/v1/sponsors?linked_client_id=eq.${encodeURIComponent(client_id)}&email=eq.${encodeURIComponent(sponsor_email)}&select=id,sponsor_token`
      );
      const sp = spRes.ok ? await spRes.json() : [];
      let token = (sp && sp[0] && sp[0].sponsor_token) || null;
      let sponsorOk = true;
      if (!sp || sp.length === 0) {
        token = genToken();
        // confidentiality_default must be 'standard' or 'private' (table CHECK).
        const ins = await sbFetch('/rest/v1/sponsors', 'POST', {
          name: finalSponsorName || finalSponsorEmail, email: finalSponsorEmail,
          sponsor_token: token, confidentiality_default: 'standard',
          active: true, linked_client_id: client_id
        }, { Prefer: 'return=minimal' });
        sponsorOk = ins.ok;
        if (!ins.ok) console.error('activate-sprint: sponsor insert failed:', (await ins.text()).slice(0, 200));
      } else if (!token) {
        token = genToken();
        const up = await sbFetch(`/rest/v1/sponsors?id=eq.${sp[0].id}`, 'PATCH',
          { sponsor_token: token, active: true }, { Prefer: 'return=minimal' });
        sponsorOk = up.ok;
      }
      // Only surface a follow-along link if the sponsor row is actually persisted.
      // Single-leader coaching sponsors get the dedicated /sponsor follow-along page
      // (roadmap #4) — a calm aggregate view with a hard confidentiality wall.
      sponsorFollowLink = sponsorOk ? `${SITE_URL}/sponsor?token=${token}` : null;
    }

    // ── 5. Stamp the activation guard (welcome_sent_at + variant) ───────────────
    const variant = isSponsored ? 'sponsored' : 'self';
    await sbFetch(
      `/rest/v1/clients?id=eq.${encodeURIComponent(client_id)}`,
      'PATCH',
      { welcome_sent_at: new Date().toISOString(), welcome_variant: variant },
      { Prefer: 'return=minimal' }
    );

    // If linked to a diagnostic, save the coaching portal URL so the leader page
    // can show the "Go to your coaching portal" button (matches markDebriefComplete).
    const portalURL = `${SITE_URL}/client?token=${client.token}`;
    if (diagnostic_id) {
      await sbFetch(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}`, 'PATCH',
        { coaching_portal_url: portalURL }, { Prefer: 'return=minimal' });
    }

    return res.status(200).json({
      ok: true,
      variant,
      leader_name:  client.name,
      leader_email: client.email,
      portal_url:   portalURL,
      goal:         client.goal_statement || priorityBehavior || null,
      sponsor_name:  finalSponsorName,
      sponsor_email: finalSponsorEmail,
      sponsor_follow_link: sponsorFollowLink,
      start_date: startDate,
      end_date:   endDate,
      baseline_deferred: baselineDeferred,
      pulses: pulseResult.scheduled || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function genToken() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

import crypto from 'node:crypto';
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
function verifyCoachSession(tok) {
  if (!tok || !COACH_SESSION_SECRET) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), bb = Buffer.from(expected);
  if (a.length !== bb.length || !crypto.timingSafeEqual(a, bb)) return null;
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
