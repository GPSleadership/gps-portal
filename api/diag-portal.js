// GPS Leadership — Diagnostic Portal Data API (Phase 1 hardening)
//
// Token-validated endpoint for the two public diagnostic pages, replacing their
// direct anon-key Supabase calls:
//   • diagnostic-leader.html  → leader token (diagnostics.leader_token)
//   • diagnostic-survey.html  → rater token  (diagnostic_raters.token)
// The token is validated server-side (service role key) and every operation is
// scoped to the matched diagnostic / rater. The browser can never read or write
// another diagnostic's data, set privileged fields, or forge rater identity.
//
// POST /api/diag-portal  { action, token, ... }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

const enc = encodeURIComponent;

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

async function diagByLeaderToken(token) {
  if (!token) return null;
  const r = await sb(`/rest/v1/diagnostics?leader_token=eq.${enc(token)}&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) || null;
}
async function raterByToken(token) {
  if (!token) return null;
  const r = await sb(`/rest/v1/diagnostic_raters?token=eq.${enc(token)}&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return (Array.isArray(rows) && rows[0]) || null;
}

// Self-report succession columns a self-rater may write on the diagnostic.
const SUCCESSION_COLS = new Set([
  'self_three_year_vision', 'self_future_self_capabilities', 'self_immediate_successor_view',
  'self_successor_candidates', 'self_successor_development_actions',
]);

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
    switch (body.action) {

      // ── Leader page (diagnostic-leader.html) ────────────────────────────────
      case 'leader-get': {
        const diag = await diagByLeaderToken(token);
        if (!diag) return res.status(401).json({ error: 'Invalid or expired link' });
        // touch last-used (fire and forget)
        sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH', { leader_token_last_used_at: new Date().toISOString() }, { Prefer: 'return=minimal' }).catch(() => {});
        const rr = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&select=id,name,email,relationship,invited_at,completed_at,is_self,token&order=created_at.asc`);
        const rrRows = rr.ok ? await rr.json() : [];
        // Only the leader's own self row carries a token (so they can self-assess).
        // Never hand the leader other raters' survey tokens.
        const raters = rrRows.map(r => r.is_self ? r : { ...r, token: undefined });
        return res.status(200).json({ ok: true, diagnostic: diag, raters });
      }
      case 'leader-add-rater': {
        const diag = await diagByLeaderToken(token);
        if (!diag) return res.status(401).json({ error: 'Invalid or expired link' });
        const rt = body.rater || {};
        if (!rt.name || !rt.email) return res.status(400).json({ error: 'name and email required' });
        const r = await sb('/rest/v1/diagnostic_raters', 'POST', {
          diagnostic_id: diag.id, name: rt.name, email: rt.email, relationship: rt.relationship || null, is_self: false,
        }, { Prefer: 'return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not add rater', detail: d }); }
        const rows = await r.json();
        return res.status(200).json({ ok: true, rater: Array.isArray(rows) ? rows[0] : rows });
      }
      case 'leader-finalize': {
        const diag = await diagByLeaderToken(token);
        if (!diag) return res.status(401).json({ error: 'Invalid or expired link' });
        const now = new Date().toISOString();
        const r = await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH', { raters_finalized_at: now, updated_at: now }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not submit list' });
        return res.status(200).json({ ok: true, raters_finalized_at: now });
      }

      // ── Rater survey page (diagnostic-survey.html) ──────────────────────────
      case 'rater-get': {
        const rater = await raterByToken(token);
        if (!rater) return res.status(401).json({ error: 'Invalid or expired link' });
        // Only the fields the survey page needs — never expose the leader's private
        // notes or self-assessment. leader_token is returned ONLY for the leader's
        // own self-assessment (so the page can redirect back to the leader portal).
        const cols = 'id,status,survey_closed_at,close_date,client_name,client_org,client_title,custom_g1_question,custom_g2_question,custom_g3_question,anonymous_feedback'
          + (rater.is_self ? ',leader_token' : '');
        const dr = await sb(`/rest/v1/diagnostics?id=eq.${rater.diagnostic_id}&select=${cols}&limit=1`);
        const diags = dr.ok ? await dr.json() : [];
        const diagnostic = diags[0] || null;
        if (!diagnostic) return res.status(404).json({ error: 'Diagnostic not found' });
        // Org logo (matched by organization name) — shown in the survey header.
        if (diagnostic.client_org) {
          try {
            const olr = await sb(`/rest/v1/organizations?name=eq.${encodeURIComponent(diagnostic.client_org)}&select=logo_url&limit=1`);
            const orows = olr.ok ? await olr.json() : [];
            if (orows[0] && orows[0].logo_url) diagnostic.org_logo_url = orows[0].logo_url;
          } catch (_) { /* logo is optional */ }
        }
        const or = await sb(`/rest/v1/diagnostic_question_overrides?diagnostic_id=eq.${rater.diagnostic_id}&select=question_code,override_text`);
        const overrides = or.ok ? await or.json() : [];
        return res.status(200).json({ ok: true, rater, diagnostic, overrides });
      }
      case 'rater-submit': {
        const rater = await raterByToken(token);
        if (!rater) return res.status(401).json({ error: 'Invalid or expired link' });
        if (rater.completed_at) return res.status(200).json({ ok: false, already: true });

        // Re-verify the survey is still open at submit time (server-authoritative)
        const dr = await sb(`/rest/v1/diagnostics?id=eq.${rater.diagnostic_id}&select=status,survey_closed_at,anonymous_feedback&limit=1`);
        const diags = dr.ok ? await dr.json() : [];
        const diag = diags[0];
        if (!diag) return res.status(404).json({ error: 'Diagnostic not found' });
        const isSelf = !!rater.is_self;
        const stillOpen = diag.status === 'survey_open' && !diag.survey_closed_at;
        const selfValid = ['intake_complete', 'self_assessment_pending', 'self_assessment_complete', 'survey_open'].includes(diag.status);
        if (!isSelf && !stillOpen) return res.status(200).json({ ok: false, closed: true });
        if (isSelf && !selfValid)  return res.status(200).json({ ok: false, closed: true });

        // Build response rows server-side, forcing the validated rater/diagnostic ids.
        // Anonymous diagnostics (hard cut): external raters' rows store
        // rater_id = NULL plus a relationship snapshot — identity is never
        // attached to answers. The leader's self-assessment always stays linked.
        const anonymize = !!diag.anonymous_feedback && !isSelf;
        const responses = Array.isArray(body.responses) ? body.responses : [];
        const rows = responses
          .filter(a => a && a.question_code && ((a.score !== undefined && a.score !== null) || (a.text_response && a.text_response.length > 0)))
          .map(a => ({
            diagnostic_id: rater.diagnostic_id,
            rater_id: anonymize ? null : rater.id,
            rater_relationship: rater.relationship || null,
            question_code: a.question_code,
            score: a.score ?? null,
            text_response: a.text_response ?? null,
          }));
        if (rows.length > 0) {
          const ir = await sb('/rest/v1/diagnostic_responses', 'POST', rows, { Prefer: 'return=minimal' });
          if (!ir.ok) { const d = await ir.json().catch(() => ({})); return res.status(500).json({ error: 'Could not save responses', detail: d }); }
        }
        await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { completed_at: new Date().toISOString() }, { Prefer: 'return=minimal' });

        if (isSelf && body.succession && typeof body.succession === 'object') {
          const upd = { self_assessment_completed_at: new Date().toISOString(), status: 'self_assessment_complete' };
          for (const [k, v] of Object.entries(body.succession)) if (SUCCESSION_COLS.has(k)) upd[k] = v;
          await sb(`/rest/v1/diagnostics?id=eq.${rater.diagnostic_id}`, 'PATCH', upd, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
