// GPS Leadership — Client Portal Data API (Phase 1 hardening)
// Single token-validated endpoint that replaces all direct anon-key Supabase
// calls in client.html. Every action derives the client from the portal token
// SERVER-SIDE (service role key) and scopes the operation to that client only —
// a caller can never read or write another client's data, and can never set
// privileged fields (token, is_active, in_coaching_program, ai_terms_*, etc.).
//
// POST /api/portal-data  { token, action, ...payload }
//
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY
//
// NOTE: CORS is '*' for now to match the rest of the API; tightened to the
// portal origin in Phase 1 Step 6 alongside the /api/ask + cron changes.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

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

// Columns a client is allowed to set on their own clients row (plan + profile).
// Anything not in this set is silently dropped — prevents privilege escalation.
const CLIENT_WRITABLE = new Set([
  'tp3_pillar', 'goal_description', 'goal_30_day', 'goal_statement',
  'behavior_1', 'behavior_2', 'start_behavior',
  'metric_1_name', 'metric_1_baseline', 'metric_1_target',
  'metric_2_name', 'metric_2_baseline', 'metric_2_target', 'metric_2_question', 'metric_2_target_avg',
  'metric_3_name', 'metric_3_baseline', 'metric_3_target',
  'metric_name', 'metric_baseline', 'metric_target', 'metric_current',
  'plan_start_date', 'reward_30_day', 'reward_90_day', 'timezone',
  'goal_90_day', 'plan_submitted_at',
  'industry', 'revenue_band', 'num_locations', 'regions_owned', 'direct_reports_count',
  'preferred_name',
]);
function pickWritable(updates) {
  const out = {};
  for (const k of Object.keys(updates || {})) if (CLIENT_WRITABLE.has(k)) out[k] = updates[k];
  return out;
}

async function findClientByToken(token) {
  if (!token) return null;
  const r = await sb(`/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&limit=1&select=id,in_coaching_program`);
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Confirm a diagnostic belongs to this client before any rater/diagnostic write.
async function diagnosticOwnedBy(diagnosticId, clientId) {
  if (!diagnosticId) return false;
  const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnosticId)}&client_id=eq.${encodeURIComponent(clientId)}&limit=1&select=id`);
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body   = req.body || {};
  const action = body.action;
  const token  = body.token;

  const client = await findClientByToken(token);
  if (!client) return res.status(401).json({ error: 'Invalid or expired portal token' });
  const clientId = client.id;

  try {
    switch (action) {

      // ── Check-in drafts ────────────────────────────────────────────────────
      case 'save-draft': {
        const r = await sb('/rest/v1/checkin_drafts?on_conflict=client_id,week_number', 'POST', {
          client_id: clientId, week_number: body.week_number, data: body.data, saved_at: new Date().toISOString(),
        }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not save draft' });
        return res.status(200).json({ ok: true });
      }
      case 'get-draft': {
        const r = await sb(`/rest/v1/checkin_drafts?client_id=eq.${clientId}&week_number=eq.${encodeURIComponent(body.week_number)}&select=data,saved_at&limit=1`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, draft: rows[0] || null });
      }
      case 'delete-draft': {
        await sb(`/rest/v1/checkin_drafts?client_id=eq.${clientId}&week_number=eq.${encodeURIComponent(body.week_number)}`, 'DELETE', null, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Check-in submission ─────────────────────────────────────────────────
      case 'submit-checkin': {
        const c = body.checkin || {};
        c.client_id = clientId;                 // force ownership; ignore any supplied id
        const r = await sb('/rest/v1/checkins', 'POST', c, { Prefer: 'return=minimal' });
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          return res.status(500).json({ error: 'Error saving check-in', detail });
        }
        if (typeof c.metric_value === 'number' && !Number.isNaN(c.metric_value)) {
          await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { metric_current: c.metric_value }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }

      // ── Client record (plan + profile, allowlisted) ─────────────────────────
      case 'update-client': {
        const updates = pickWritable(body.updates);
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No writable fields' });
        const r = await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', updates, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Update failed', detail }); }
        return res.status(200).json({ ok: true });
      }

      // ── Stakeholders ────────────────────────────────────────────────────────
      // ── Results tab data (post-lockdown read path; anon reads are dead) ─────
      case 'results-data': {
        const [ck, sr, st, sc, sh] = await Promise.all([
          sb(`/rest/v1/checkins?client_id=eq.${clientId}&select=*&order=week_number.asc`),
          sb(`/rest/v1/survey_responses?client_id=eq.${clientId}&select=checkpoint,score,scale,open_response,comments,comments_visible_to_client,created_at&order=created_at.asc`),
          sb(`/rest/v1/survey_tokens?client_id=eq.${clientId}&select=checkpoint,non_response_flagged,is_used`),
          sb(`/rest/v1/self_checks?client_id=eq.${clientId}&select=checkpoint,q1_score,q2_score,q3_response,submitted_at`),
          sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=id,name,email,relationship,is_supervisor,is_board_member,confirmed_at,created_at&order=created_at.asc`),
        ]);
        const j = async (r) => (r.ok ? await r.json() : []);
        return res.status(200).json({
          ok: true,
          checkins: await j(ck),
          survey_responses: await j(sr),
          survey_tokens: await j(st),
          self_checks: await j(sc),
          stakeholders: await j(sh),
        });
      }

      case 'get-stakeholders': {
        const r = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=*`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, stakeholders: rows });
      }
      case 'add-stakeholders': {
        const list = Array.isArray(body.stakeholders) ? body.stakeholders : [];
        const clean = list.filter(s => s && s.name && s.email)
          .map(s => ({
            client_id: clientId, name: s.name, email: s.email, relationship: s.relationship || null,
            is_supervisor: (s.is_supervisor != null) ? !!s.is_supervisor : (s.relationship === 'Manager'),
            is_board_member: !!s.is_board_member,
            is_active: true, added_by: s.added_by || 'client_portal',
          }));
        if (clean.length === 0) return res.status(200).json({ ok: true, inserted: 0 });
        // de-dupe against existing active emails for this client
        const er = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&select=email`);
        const existing = new Set((er.ok ? await er.json() : []).map(s => (s.email || '').toLowerCase()));
        const toInsert = clean.filter(s => !existing.has(s.email.toLowerCase()));
        if (toInsert.length === 0) return res.status(200).json({ ok: true, inserted: 0 });
        const r = await sb('/rest/v1/stakeholders', 'POST', toInsert, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Insert failed', detail }); }
        return res.status(200).json({ ok: true, inserted: toInsert.length });
      }
      case 'update-stakeholder': {
        // scope: only a stakeholder belonging to this client
        const r = await sb(`/rest/v1/stakeholders?id=eq.${encodeURIComponent(body.stakeholder_id)}&client_id=eq.${clientId}`, 'PATCH', body.updates || {}, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Update failed' });
        return res.status(200).json({ ok: true });
      }
      case 'deactivate-stakeholder': {
        // soft-delete, only if still a draft (confirmed_at IS NULL), scoped to this client
        await sb(`/rest/v1/stakeholders?id=eq.${encodeURIComponent(body.stakeholder_id)}&client_id=eq.${clientId}&confirmed_at=is.null`, 'PATCH', { is_active: false }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'confirm-stakeholders': {
        const r = await sb(`/rest/v1/stakeholders?client_id=eq.${clientId}&is_active=eq.true&confirmed_at=is.null`, 'PATCH', { confirmed_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not confirm stakeholders' });
        return res.status(200).json({ ok: true });
      }

      // ── Self checks ─────────────────────────────────────────────────────────
      case 'add-self-check': {
        const sc = body.self_check || {};
        sc.client_id = clientId;
        const r = await sb('/rest/v1/self_checks', 'POST', sc, { Prefer: 'return=minimal' });
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          // 23505 = unique violation → already submitted (frontend treats as benign)
          if (detail && detail.code === '23505') return res.status(200).json({ ok: false, duplicate: true });
          return res.status(500).json({ error: 'Could not save self-check', detail });
        }
        return res.status(200).json({ ok: true });
      }

      // ── Activity / lifecycle stamps ─────────────────────────────────────────
      case 'touch-activity': {
        await sb(`/rest/v1/clients?id=eq.${clientId}`, 'PATCH', { last_active_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'set-first-active': {
        // set portal_first_active_at only if not already set
        await sb(`/rest/v1/clients?id=eq.${clientId}&portal_first_active_at=is.null`, 'PATCH', { portal_first_active_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ── Sponsor link: is this client also an executive sponsor? ─────────────
      // Matches the client's email to a sponsor record so their portal can show a
      // Decision Room tab instead of a separate link. Returns the sponsor token
      // (their own access) only to the authenticated, email-matched client.
      case 'get-my-sponsor': {
        const email = (client.email || '').trim();
        if (!email) return res.status(200).json({ ok: true, sponsor: null });
        const sp = await sb(`/rest/v1/sponsors?email=ilike.${encodeURIComponent(email)}&select=id,sponsor_token,name&limit=1`);
        const sprows = sp.ok ? await sp.json() : [];
        const sponsor = sprows[0];
        if (!sponsor || !sponsor.sponsor_token) return res.status(200).json({ ok: true, sponsor: null });
        const lt = await sb(`/rest/v1/sponsor_teams?sponsor_id=eq.${encodeURIComponent(sponsor.id)}&select=team_id`);
        const links = lt.ok ? await lt.json() : [];
        return res.status(200).json({ ok: true, sponsor: { token: sponsor.sponsor_token, name: sponsor.name, team_count: links.length } });
      }

      // ── Diagnostic (leader self-service rater list) ─────────────────────────
      case 'diag-get': {
        // The leader's latest diagnostic + raters + finalized report draft, scoped
        // to this client. Replaces the old anon db.from reads (dead post-v26).
        const r = await sb(`/rest/v1/diagnostics?client_id=eq.${clientId}&select=*&order=created_at.desc&limit=1`);
        const rows = r.ok ? await r.json() : [];
        const diag = rows[0] || null;
        if (!diag) return res.status(200).json({ ok: true, diagnostic: null });
        const rr = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${encodeURIComponent(diag.id)}&select=*&order=created_at.asc`);
        const raters = rr.ok ? await rr.json() : [];
        let report = null;
        if (diag.report_finalized_at) {
          const dr = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${encodeURIComponent(diag.id)}&select=*&order=generated_at.desc&limit=1`);
          const drows = dr.ok ? await dr.json() : [];
          report = drows[0] || null;
        }
        return res.status(200).json({ ok: true, diagnostic: diag, raters, report });
      }
      case 'diag-get-raters': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const r = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${encodeURIComponent(body.diagnostic_id)}&select=*&order=created_at.asc`);
        const rows = r.ok ? await r.json() : [];
        return res.status(200).json({ ok: true, raters: rows });
      }
      case 'diag-add-rater': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const rt = body.rater || {};
        const r = await sb('/rest/v1/diagnostic_raters', 'POST', {
          diagnostic_id: body.diagnostic_id, name: rt.name, email: rt.email,
          relationship: rt.relationship || null, is_self: false,
        }, { Prefer: 'return=minimal' });
        if (!r.ok) { const detail = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add rater', detail }); }
        return res.status(200).json({ ok: true });
      }
      case 'diag-remove-rater': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        // only remove a rater that belongs to this diagnostic and isn't completed
        await sb(`/rest/v1/diagnostic_raters?id=eq.${encodeURIComponent(body.rater_id)}&diagnostic_id=eq.${encodeURIComponent(body.diagnostic_id)}&completed_at=is.null`, 'DELETE', null, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }
      case 'diag-finalize-raters': {
        if (!(await diagnosticOwnedBy(body.diagnostic_id, clientId))) return res.status(403).json({ error: 'Not your diagnostic' });
        const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(body.diagnostic_id)}`, 'PATCH', {
          raters_finalized_at: new Date().toISOString(), status: 'rater_setup',
        }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not submit rater list' });
        return res.status(200).json({ ok: true });
      }

      // ── Workshop sponsor tab: return workshops this client sponsors ──────────
      case 'my-workshops': {
        // Look up workshop_sponsors rows for this client
        const enc = encodeURIComponent;
        const links = await (async () => {
          const r = await sb(`/rest/v1/workshop_sponsors?client_id=eq.${enc(clientId)}&select=workshop_id,added_at`);
          if (!r.ok) return [];
          return (await r.json().catch(() => [])) || [];
        })();
        if (!links.length) return res.status(200).json({ ok: true, workshops: [] });
        // Fetch each workshop — only surface-safe fields (no raw data, no survey content)
        const workshops = (await Promise.all(links.map(async l => {
          const r = await sb(`/rest/v1/workshops?id=eq.${enc(l.workshop_id)}&select=id,title,engagement_kind,status,workshop_date,client_org_name,roster_locked,roster_file_url,roster_uploaded_at,organization_id&limit=1`);
          if (!r.ok) return null;
          const rows = await r.json().catch(() => []);
          const w = Array.isArray(rows) ? rows[0] : rows;
          if (!w) return null;
          // Fetch org logo if org is linked
          let org_logo_url = null;
          if (w.organization_id) {
            const orgR = await sb(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=logo_url&limit=1`);
            if (orgR.ok) {
              const orgRows = await orgR.json().catch(() => []);
              org_logo_url = (Array.isArray(orgRows) ? orgRows[0] : orgRows)?.logo_url || null;
            }
          }
          // Participant count (sponsor sees this but not individual names/data)
          const countR = await sb(`/rest/v1/workshop_participants?workshop_id=eq.${enc(w.id)}&select=id`);
          const countRows = countR.ok ? (await countR.json().catch(() => [])) : [];
          return {
            ...w,
            org_logo_url,
            participant_count: Array.isArray(countRows) ? countRows.length : 0,
            sponsor_added_at: l.added_at,
          };
        }))).filter(Boolean);
        return res.status(200).json({ ok: true, workshops });
      }

      // ── Sponsor: upload/replace participant roster (before lock only) ─────────
      case 'sponsor-upload-roster': {
        const enc = encodeURIComponent;
        const wid  = body.workshop_id;
        const rows = Array.isArray(body.participants) ? body.participants : (Array.isArray(body.rows) ? body.rows : []);
        if (!wid) return res.status(400).json({ error: 'workshop_id required' });
        // Verify this client is actually a sponsor for this workshop
        const linkR = await sb(`/rest/v1/workshop_sponsors?workshop_id=eq.${enc(wid)}&client_id=eq.${enc(clientId)}&select=workshop_id&limit=1`);
        const linkRows = linkR.ok ? (await linkR.json().catch(() => [])) : [];
        if (!Array.isArray(linkRows) || !linkRows.length) return res.status(403).json({ error: 'Not a sponsor for this workshop' });
        // Check roster is not locked
        const w = await (async () => {
          const r = await sb(`/rest/v1/workshops?id=eq.${enc(wid)}&select=roster_locked&limit=1`);
          if (!r.ok) return null;
          const wr = await r.json().catch(() => []);
          return Array.isArray(wr) ? wr[0] : wr;
        })();
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        if (w.roster_locked) return res.status(403).json({ error: 'Roster is locked. Contact Alex to make changes.' });
        if (!rows.length) return res.status(400).json({ error: 'No rows provided' });
        // Upsert participants (same logic as coach upload-roster)
        let created = 0, linked = 0, skipped = 0;
        for (const raw of rows) {
          const name  = ((raw.first_name || '') + ' ' + (raw.last_name || '')).trim() || (raw.name || '').trim();
          const email = (raw.email || '').trim().toLowerCase();
          if (!email || !name) { skipped++; continue; }
          let client = await (async () => {
            const r = await sb(`/rest/v1/clients?email=eq.${enc(email)}&select=id&limit=1`);
            if (!r.ok) return null;
            const cr = await r.json().catch(() => []);
            return Array.isArray(cr) ? cr[0] : cr;
          })();
          if (!client) {
            const ins = await sb('/rest/v1/clients', 'POST', {
              name, email, title: raw.role_title || raw.role || raw.title || null,
              is_workshop_participant: true, in_coaching_program: false, is_active: true,
            }, { Prefer: 'return=representation' });
            const cr = await ins.json().catch(() => []);
            client = Array.isArray(cr) ? cr[0] : cr;
            if (!client?.id) { skipped++; continue; }
            created++;
          }
          const linkIns = await sb('/rest/v1/workshop_participants', 'POST', {
            workshop_id: wid, client_id: client.id,
            role: raw.role_title || raw.role || raw.title || null,
            location: raw.location || raw.region || null,
            department: raw.department || null,
          }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
          if (linkIns.ok) linked++; else skipped++;
        }
        // Mark file uploaded timestamp
        await sb(`/rest/v1/workshops?id=eq.${enc(wid)}`, 'PATCH',
          { roster_uploaded_at: new Date().toISOString() },
          { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, created, linked, skipped });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
