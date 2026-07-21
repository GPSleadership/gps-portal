// GPS Leadership — Workshop Survey API (participant + sponsor feedback)
//
// Token-validated, public-facing endpoint for two pages:
//   • workshop-survey.html  → participant pre/post survey  (participant_token)
//   • workshop-survey.html (feedback mode) → sponsor post-debrief satisfaction,
//        testimonial, bonus unlock, referral  (sponsor_token)
//
// Post-v26 model: the browser never touches Supabase. The token is validated
// server-side (service role) and every write is scoped to the matched
// participant / workshop. The window is re-checked server-side at submit time.
//
// POST /api/workshop-survey  { action, token, ... }
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json', ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function sbGet(path) { const r = await sb(path); if (!r.ok) return []; const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; }
async function sbOne(path) { return (await sbGet(path))[0] || null; }
const isoNow = () => new Date().toISOString();

async function participantByToken(token) {
  if (!token) return null;
  return sbOne(`/rest/v1/workshop_participants?participant_token=eq.${enc(token)}&select=*&limit=1`);
}
async function workshopBySponsorToken(token) {
  if (!token) return null;
  return sbOne(`/rest/v1/workshops?sponsor_token=eq.${enc(token)}&select=*&limit=1`);
}
async function workshopByRoomToken(token) {
  if (!token) return null;
  return sbOne(`/rest/v1/workshops?room_survey_token=eq.${enc(token)}&select=*&limit=1`);
}

// Live questions for a phase = approved/live, ordered. Per-workshop rows win;
// if a workshop has none for the phase yet, fall back to the global templates.
async function liveQuestions(workshopId, phase) {
  let qs = await sbGet(`/rest/v1/workshop_questions?workshop_id=eq.${enc(workshopId)}&phase=eq.${enc(phase)}&status=in.(approved,live)&select=question_id,question_theme,question_text,response_type,scale_min,scale_max,sort_order&order=sort_order.asc`);
  if (!qs.length) qs = await sbGet(`/rest/v1/workshop_questions?workshop_id=is.null&phase=eq.${enc(phase)}&status=in.(approved,live)&select=question_id,question_theme,question_text,response_type,scale_min,scale_max,sort_order&order=sort_order.asc`);
  return qs;
}

function phaseOpen(w, phase) {
  const openAt  = phase === 'pre' ? w.pre_survey_open_at  : w.post_survey_open_at;
  const closeAt = phase === 'pre' ? w.pre_survey_close_at : w.post_survey_close_at;
  if (!openAt) return false;
  if (new Date(openAt) > new Date()) return false;
  if (closeAt && new Date(closeAt) < new Date()) return false;
  return true;
}

// Replace this participant's responses for a phase (clean resume / re-submit).
// anonymize (hard cut, final submit on anonymous engagements): the linked draft
// rows are deleted as usual, but the final rows are inserted with
// participant_id = NULL — identity is never attached to submitted answers.
// The in-room QR path has always written such rows; aggregation handles them.
async function replaceResponses(workshopId, participantId, phase, responses, questions, anonymize = false) {
  await sb(`/rest/v1/workshop_responses?participant_id=eq.${enc(participantId)}&phase=eq.${enc(phase)}`, 'DELETE', null, { Prefer: 'return=minimal' });
  const qById = Object.fromEntries((questions || []).map(q => [q.question_id, q]));
  const rows = (responses || [])
    .filter(a => a && a.question_id && ((a.value != null && a.value !== '') || (a.text && a.text.length)))
    .map(a => {
      const q = qById[a.question_id] || {};
      return {
        workshop_id: workshopId, participant_id: anonymize ? null : participantId, phase,
        question_id: a.question_id, question_text: q.question_text || a.question_text || null,
        question_theme: q.question_theme || a.question_theme || null,
        response_value: (a.value != null && a.value !== '' && !isNaN(a.value)) ? Number(a.value) : null,
        response_text: a.text || null,
      };
    });
  if (rows.length) await sb('/rest/v1/workshop_responses', 'POST', rows, { Prefer: 'return=minimal' });
  return rows.length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body = req.body || {};
  const token = body.token;

  try {
    switch (body.action) {

      // ── Participant survey: load (with resume) ───────────────────────────────
      case 'get': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const p = await participantByToken(token);
        if (!p) return res.status(401).json({ error: 'Invalid or expired link' });
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(p.workshop_id)}&select=id,title,client_org_name,workshop_date,engagement_kind,organization_id,pre_survey_open_at,pre_survey_close_at,post_survey_open_at,post_survey_close_at,anonymous_feedback&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        const open = phaseOpen(w, phase);
        const completed = phase === 'pre' ? !!p.pre_completed_at : !!p.post_completed_at;
        const questions = await liveQuestions(w.id, phase);
        const saved = await sbGet(`/rest/v1/workshop_responses?participant_id=eq.${enc(p.id)}&phase=eq.${enc(phase)}&select=question_id,response_value,response_text`);
        const client = await sbOne(`/rest/v1/clients?id=eq.${enc(p.client_id)}&select=name,title&limit=1`);
        // Mark in_progress on first open (non-fatal).
        const statusCol = phase === 'pre' ? 'pre_status' : 'post_status';
        if (open && !completed && p[statusCol] === 'not_started') {
          sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH', { [statusCol]: 'in_progress' }, { Prefer: 'return=minimal' }).catch(() => {});
        }
        // Look up org logo (v40) — non-fatal
        let orgLogoUrl = null;
        if (w.organization_id) {
          const org = await sbOne(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=logo_url&limit=1`).catch(() => null);
          if (org?.logo_url) orgLogoUrl = org.logo_url;
        }
        return res.status(200).json({
          ok: true, open, completed, phase,
          workshop: { title: w.title, org: w.client_org_name, workshop_date: w.workshop_date, kind: w.engagement_kind || 'workshop', org_logo_url: orgLogoUrl, anonymous: !!w.anonymous_feedback },
          participant: { name: client?.name || '', role: client?.title || p.role || '' },
          questions, saved,
        });
      }

      // ── Participant survey: record AI-disclosure consent (before question one) ─
      case 'record-consent': {
        const p = await participantByToken(token);
        if (!p) return res.status(401).json({ error: 'Invalid or expired link' });
        if (!p.consent_ai_disclosure_at) {
          await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH', {
            consent_ai_disclosure_at: isoNow(),
            consent_version: body.consent_version || null,
            consent_text_id: body.consent_text_id || null,
          }, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true });
      }

      // ── Participant survey: save progress (resume later) ─────────────────────
      case 'save-progress': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const p = await participantByToken(token);
        if (!p) return res.status(401).json({ error: 'Invalid or expired link' });
        const questions = await liveQuestions(p.workshop_id, phase);
        const n = await replaceResponses(p.workshop_id, p.id, phase, body.responses, questions);
        const statusCol = phase === 'pre' ? 'pre_status' : 'post_status';
        await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH', { [statusCol]: 'in_progress' }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, saved: n });
      }

      // ── Participant survey: submit (final) ───────────────────────────────────
      case 'submit': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const p = await participantByToken(token);
        if (!p) return res.status(401).json({ error: 'Invalid or expired link' });
        // P0-6: no response is processed without a recorded AI-disclosure consent.
        if (!p.consent_ai_disclosure_at) return res.status(200).json({ ok: false, consent_required: true });
        const w = await sbOne(`/rest/v1/workshops?id=eq.${enc(p.workshop_id)}&select=*&limit=1`);
        if (!w) return res.status(404).json({ error: 'Workshop not found' });
        if (!phaseOpen(w, phase)) return res.status(200).json({ ok: false, closed: true });
        // Double-submit guard: once complete, anonymous rows can't be replaced
        // (no participant link), so a re-submit would duplicate them.
        const doneColPre = phase === 'pre' ? p.pre_completed_at : p.post_completed_at;
        if (doneColPre) return res.status(200).json({ ok: false, already: true });
        const questions = await liveQuestions(w.id, phase);
        const n = await replaceResponses(w.id, p.id, phase, body.responses, questions, !!w.anonymous_feedback);
        const statusCol = phase === 'pre' ? 'pre_status' : 'post_status';
        const doneCol   = phase === 'pre' ? 'pre_completed_at' : 'post_completed_at';
        await sb(`/rest/v1/workshop_participants?id=eq.${enc(p.id)}`, 'PATCH', { [statusCol]: 'complete', [doneCol]: isoNow() }, { Prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, saved: n });
      }

      // ── In-room (QR) survey: one shared link, load ───────────────────────────
      case 'room-get': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const w = await workshopByRoomToken(token);
        if (!w) return res.status(401).json({ error: 'Invalid or expired link' });
        const open = phaseOpen(w, phase);
        const questions = await liveQuestions(w.id, phase);
        // Look up org logo (v40) — non-fatal
        let roomOrgLogoUrl = null;
        if (w.organization_id) {
          const org = await sbOne(`/rest/v1/organizations?id=eq.${enc(w.organization_id)}&select=logo_url&limit=1`).catch(() => null);
          if (org?.logo_url) roomOrgLogoUrl = org.logo_url;
        }
        return res.status(200).json({
          ok: true, open, phase, room: true,
          workshop: { title: w.title, org: w.client_org_name, workshop_date: w.workshop_date, kind: w.engagement_kind || 'workshop', org_logo_url: roomOrgLogoUrl, anonymous: !!w.anonymous_feedback },
          questions,
        });
      }

      // ── In-room (QR) survey: submit (anonymous, or matched by email) ──────────
      case 'room-submit': {
        const phase = body.phase === 'post' ? 'post' : 'pre';
        const w = await workshopByRoomToken(token);
        if (!w) return res.status(401).json({ error: 'Invalid or expired link' });
        if (!phaseOpen(w, phase)) return res.status(200).json({ ok: false, closed: true });
        const questions = await liveQuestions(w.id, phase);

        // Optional identify: match/create ONE profile per person, link to workshop.
        // Anonymous engagements never identify — even if a respondent was somehow
        // sent an email/name, it is ignored and the rows stay unlinked.
        let participantId = null;
        const email = w.anonymous_feedback ? '' : (body.respondent && body.respondent.email || '').trim().toLowerCase();
        const name  = (body.respondent && body.respondent.name  || '').trim();
        if (email) {
          let client = await sbOne(`/rest/v1/clients?email=eq.${enc(email)}&select=id&limit=1`);
          if (!client) {
            const ins = await sb('/rest/v1/clients', 'POST', { name: name || email, email, organization: w.client_org_name || null, is_workshop_participant: true, in_coaching_program: false, is_active: true }, { Prefer: 'return=representation' });
            const cr = await ins.json().catch(() => []); client = Array.isArray(cr) ? cr[0] : cr;
          }
          if (client && client.id) {
            const link = await sb('/rest/v1/workshop_participants?on_conflict=workshop_id,client_id', 'POST', { workshop_id: w.id, client_id: client.id }, { Prefer: 'resolution=merge-duplicates,return=representation' });
            const lr = await link.json().catch(() => []); const p = Array.isArray(lr) ? lr[0] : lr;
            if (p && p.id) participantId = p.id;
          }
        }

        if (participantId) {
          // Matched: replace this person's responses for the phase (idempotent).
          await replaceResponses(w.id, participantId, phase, body.responses, questions);
          const statusCol = phase === 'pre' ? 'pre_status' : 'post_status';
          const doneCol   = phase === 'pre' ? 'pre_completed_at' : 'post_completed_at';
          await sb(`/rest/v1/workshop_participants?id=eq.${enc(participantId)}`, 'PATCH', { [statusCol]: 'complete', [doneCol]: isoNow() }, { Prefer: 'return=minimal' });
        } else {
          // Anonymous: insert workshop-level rows (counts toward team aggregate).
          const qById = Object.fromEntries((questions || []).map(q => [q.question_id, q]));
          const rows = (body.responses || [])
            .filter(a => a && a.question_id && ((a.value != null && a.value !== '') || (a.text && a.text.length)))
            .map(a => { const q = qById[a.question_id] || {}; return {
              workshop_id: w.id, participant_id: null, phase,
              question_id: a.question_id, question_text: q.question_text || null, question_theme: q.question_theme || null,
              response_value: (a.value != null && a.value !== '' && !isNaN(a.value)) ? Number(a.value) : null,
              response_text: a.text || null,
            }; });
          if (rows.length) await sb('/rest/v1/workshop_responses', 'POST', rows, { Prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, matched: !!participantId });
      }

      // ── Sponsor feedback: load base questions ────────────────────────────────
      case 'sponsor-feedback-get': {
        const w = await workshopBySponsorToken(token);
        if (!w) return res.status(401).json({ error: 'Invalid or expired link' });
        // Sponsor title drives the NPS referent (top-level vs generic).
        let sponsorTitle = null;
        if (w.sponsor_client_id) {
          const c = await sbOne(`/rest/v1/clients?id=eq.${enc(w.sponsor_client_id)}&select=title&limit=1`);
          sponsorTitle = c && c.title || null;
        }
        return res.status(200).json({
          ok: true,
          workshop: { title: w.title, org: w.client_org_name, kind: w.engagement_kind || 'workshop' },
          sponsor_title: sponsorTitle,
          bonus: w.bonus_resource_config || null,
          already: !!w.recap_sent_at && false, // feedback can be re-opened; recap is separate
        });
      }

      // ── Sponsor feedback: submit (NPS branch → testimonial/bonus/referral) ────
      case 'sponsor-feedback-submit': {
        const w = await workshopBySponsorToken(token);
        if (!w) return res.status(401).json({ error: 'Invalid or expired link' });
        const nps = (body.nps != null && !isNaN(body.nps)) ? Math.max(0, Math.min(10, Number(body.nps))) : null;
        const sponsorClientId = w.sponsor_client_id || null;

        // Store the raw feedback responses (phase='feedback').
        const respRows = [];
        if (nps != null) respRows.push({ workshop_id: w.id, sponsor_id: sponsorClientId, phase: 'feedback', question_id: 'SPONSOR_NPS', question_text: 'Likelihood to recommend (0-10)', question_theme: 'satisfaction', response_value: nps });
        for (const [q, ans] of Object.entries(body.responses || {})) {
          if (ans == null || ans === '') continue;
          respRows.push({ workshop_id: w.id, sponsor_id: sponsorClientId, phase: 'feedback', question_id: 'SPONSOR_TEXT', question_text: q, question_theme: 'feedback', response_text: String(ans) });
        }
        if (respRows.length) await sb('/rest/v1/workshop_responses', 'POST', respRows, { Prefer: 'return=minimal' });

        const tier = nps == null ? 'unknown' : (nps >= 9 ? 'promoter' : nps >= 7 ? 'satisfied' : nps === 6 ? 'borderline' : 'red');

        // Borderline / red flag → mark for coach review; no upsell artifacts.
        if (tier === 'borderline' || tier === 'red') {
          await sb(`/rest/v1/workshops?id=eq.${enc(w.id)}`, 'PATCH', { needs_review: true, updated_at: isoNow() }, { Prefer: 'return=minimal' });
        }

        // Promoter / satisfied → capture testimonial (reuse testimonials table).
        let bonus = null;
        if ((tier === 'promoter' || tier === 'satisfied') && sponsorClientId && body.responses && Object.keys(body.responses).length) {
          await sb('/rest/v1/testimonials', 'POST', {
            client_id: sponsorClientId, workshop_id: w.id, engagement_type: 'workshop',
            source: 'workshop_debrief', responses: body.responses, rating_nps: nps,
            permission_public_use: !!body.consent_public,
          }, { Prefer: 'return=minimal' });
          if (tier === 'promoter') bonus = w.bonus_resource_config || null;
        }

        // Referral (reuse referrals table) — any tier that submitted one, but the
        // page only offers it to promoter (strong) / satisfied (soft).
        let referralLogged = false;
        if (body.referral && body.referral.email && sponsorClientId && tier !== 'red' && tier !== 'borderline') {
          await sb('/rest/v1/referrals', 'POST', {
            referrer_client_id: sponsorClientId, workshop_id: w.id,
            referral_name: body.referral.name || '', referral_email: body.referral.email,
            referral_org: body.referral.org || null, engagement_type_suggested: 'workshop',
            email_subject: body.referral.subject || null, email_body: body.referral.body || null,
            status: 'draft_email_created',
          }, { Prefer: 'return=minimal' });
          referralLogged = true;
        }

        return res.status(200).json({ ok: true, tier, bonus, referralLogged });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
