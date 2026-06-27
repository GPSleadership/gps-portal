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
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL || 'noreply@portal.gpsleadership.org';

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

// ── Editable copy (Communication > Templates) ────────────────────────────────
// Fetch an approved template; callers fall back to hardcoded copy if none, so a
// missing/un-approved row never breaks a send. Markers (**bold** *italic*
// __underline__ "- " bullets "> " indent) match the Templates editor + renderers.
const _tplCache = {};
async function getApprovedTemplate(key) {
  if (_tplCache[key] !== undefined) return _tplCache[key];
  let tpl = null;
  try {
    const r = await sb(`/rest/v1/email_templates?template_key=eq.${enc(key)}&is_approved=eq.true&select=subject,body_text&limit=1`);
    if (r.ok) { const d = await r.json(); tpl = (Array.isArray(d) && d[0]) ? d[0] : null; }
  } catch (_) { tpl = null; }
  _tplCache[key] = tpl;
  return tpl;
}
function fillTemplate(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => (vars && vars[k] != null) ? String(vars[k]) : '');
}
function tplProse(text) {
  function inline(s) {
    return s
      .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '<span style="text-decoration:underline;">$1</span>')
      .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>');
  }
  const lines = String(text || '').split(/\n/);
  let html = '', buf = [];
  function flush() {
    if (buf.length) { html += '<ul style="margin:0 0 14px;padding-left:20px;">' + buf.map(li => `<li style="margin:0 0 6px;">${inline(li)}</li>`).join('') + '</ul>'; buf = []; }
  }
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    const b = l.match(/^[-*]\s+(.*)$/);
    if (b) { buf.push(b[1]); continue; }
    flush();
    const ind = l.match(/^>\s+(.*)$/);
    if (ind) { html += `<p style="margin:0 0 12px;padding-left:20px;">${inline(ind[1])}</p>`; continue; }
    html += `<p style="margin:0 0 12px;">${inline(l)}</p>`;
  }
  flush();
  return html;
}

// ── Rater-invite "brief your raters" email to the leader ──────────────────────
async function sendMail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return { ok: false };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
        to: [to], cc: ['team@gpsleadership.org'], reply_to: 'alex@gpsleadership.org',
        subject, html,
      }),
    });
    return { ok: r.ok };
  } catch (_) { return { ok: false }; }
}

// Editable copy (Communication > Templates):
//   rater_brief_cover → email subject + the leader-facing cover note
//   rater_brief_draft → the "draft language for your raters" block. {NAME} is a
//     literal placeholder the leader replaces; {{leader_name}} is filled here.
// Both fall back to the original hardcoded copy if no approved row exists.
async function buildRaterBriefEmail({ firstName, fullName, raterCount }) {
  const countPhrase = raterCount > 0
    ? `The group of ${raterCount} people you added gives us a strong, well-rounded basis for honest feedback.`
    : `The group of people you added gives us a strong, well-rounded basis for honest feedback.`;
  const vars = { first_name: firstName, leader_name: (fullName || firstName), rater_count: raterCount, count_phrase: countPhrase };

  const coverDefault = [
    `Hello ${firstName},`,
    `Thank you for completing your self-assessment and entering your rater list. ${countPhrase}`,
    `We're now moving into the most important phase: gathering confidential input on your leadership from the people who see you lead day to day. What they share will shape a focused 90-day plan built around how you actually show up, not guesswork.`,
    `The next step is yours, and it's simple. Before we release the surveys, send a short note to your raters so they know it's coming, what it's about, and that it's confidential. A quick heads-up from you meaningfully improves both response rate and candor.`,
  ].join('\n\n');

  const draftDefault = [
    `Hi {NAME},`,
    `I want to give you a heads-up about something important happening over the next few days. I've engaged Alex Tremble and GPS Leadership Solutions to run a 14-Day Executive Leadership Diagnostic focused on me (e.g., how I lead, communicate, and support) all of you. My goal is simple, get honest feedback so I can keep getting better for our team and the people we serve.`,
    `In the next few days, you'll receive a short, confidential survey by email from Alex / GPS Leadership Solutions. A few things to know:`,
    `- It's about my leadership; not an evaluation of you.`,
    `- It's confidential. GPS compiles and summarizes the results; I see themes and examples, never who said what.`,
    `- It's development-focused, not a performance review. The point is to help me improve so we all work better together.`,
    `- It's short, about 8 to 10 minutes, and open for roughly a week.`,
    `When your personal link arrives, please complete it honestly. Your candid input will directly shape where I focus over the next 90 days and how we make this a better place to work and serve. Thank you for your help, and for what you do every day.`,
    `${fullName || firstName}`,
  ].join('\n\n');

  const coverTpl = await getApprovedTemplate('rater_brief_cover');
  const draftTpl = await getApprovedTemplate('rater_brief_draft');
  const coverHtml = tplProse((coverTpl && coverTpl.body_text) ? fillTemplate(coverTpl.body_text, vars) : coverDefault);
  const draftHtml = tplProse((draftTpl && draftTpl.body_text) ? fillTemplate(draftTpl.body_text, vars) : draftDefault);
  const subject = (coverTpl && coverTpl.subject)
    ? fillTemplate(coverTpl.subject, vars)
    : 'Next step: inviting your raters for the 14-Day Executive Leadership Diagnostic';

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.6;font-size:15px;">
    ${coverHtml}
    <p style="font-weight:700;margin-bottom:6px;">Here's draft language you can send to your raters (feel free to edit to fit your voice):</p>
    <div style="border-left:3px solid #1A3D6E;background:#f5f7fa;padding:14px 18px;border-radius:0 6px 6px 0;color:#333;">
      ${draftHtml}
    </div>
    <p style="margin-top:16px;"><strong>One important note:</strong> when you send your version of this to your raters, please CC alex@gpsleadership.org and Team@gpsleadership.org. That CC is how we know your raters have been informed and that it's time to release the survey.</p>
    <p>Once that email goes out and we're CC'd, you don't need to do anything else until your debrief. We'll handle the survey launch, reminders, and the analysis from there.</p>
    <p style="margin-top:18px;">All my best,<br>Alex D. Tremble<br><span style="color:#555;font-size:13px;">Founder &amp; CEO, GPS Leadership Solutions</span></p>
    <p style="font-size:12px;color:#777;">We install simple leadership operating systems so CEOs of multi-location, operations-heavy companies doing roughly eight figures stop being the bottleneck.<br><a href="https://www.GPSLeadership.org" style="color:#004369;">www.GPSLeadership.org</a></p>
  </div>`;
  return { html, subject };
}

// Fires ONCE, only when BOTH the self-assessment is complete AND the rater list
// has been explicitly submitted. Best-effort: never blocks the leader's action.
async function maybeSendRaterBrief(diagId) {
  try {
    const dr = await sb(`/rest/v1/diagnostics?id=eq.${enc(diagId)}&select=client_name,client_email,self_assessment_completed_at,raters_finalized_at,rater_brief_sent_at&limit=1`);
    if (!dr.ok) return;
    const d = (await dr.json())[0];
    if (!d || !d.client_email) return;
    if (!d.self_assessment_completed_at || !d.raters_finalized_at) return; // both steps required
    if (d.rater_brief_sent_at) return;                                     // already sent — idempotent
    let count = 0;
    const cr = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${enc(diagId)}&is_self=eq.false&select=id`);
    if (cr.ok) count = (await cr.json()).length;
    const fullName  = String(d.client_name || '').trim();
    const firstName = fullName.split(/\s+/)[0] || 'there';
    const { html, subject } = await buildRaterBriefEmail({ firstName, fullName, raterCount: count });
    const sent = await sendMail(d.client_email, subject, html);
    if (sent.ok) {
      await sb(`/rest/v1/diagnostics?id=eq.${enc(diagId)}`, 'PATCH', { rater_brief_sent_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    }
  } catch (_) { /* best-effort */ }
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
        const rr = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&select=id,name,email,relationship,invited_at,completed_at,is_self,token,will_interview&order=created_at.asc`);
        const rrRows = rr.ok ? await rr.json() : [];
        // Only the leader's own self row carries a token (so they can self-assess).
        // Never hand the leader other raters' survey tokens.
        const raters = rrRows.map(r => r.is_self ? r : { ...r, token: undefined });
        // Org logo (matched by organization name) — shown in the leader portal header.
        if (diag.client_org) {
          try {
            const olr = await sb(`/rest/v1/organizations?name=eq.${encodeURIComponent(diag.client_org)}&select=logo_url&limit=1`);
            const orows = olr.ok ? await olr.json() : [];
            if (orows[0] && orows[0].logo_url) diag.org_logo_url = orows[0].logo_url;
          } catch (_) { /* logo is optional */ }
        }
        // When the report is finalized, attach the latest draft's numeric scores so the
        // leader sees their color-coded visual results page (TP3, pillars, impact, bench,
        // self-vs-others). Gated to finalized states; never exposes the AI narrative here.
        if (['report_final','debrief_complete','plan_active'].includes(diag.status)) {
          try {
            const sr = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${diag.id}&select=scores_json,raw_markdown,generated_at&order=generated_at.desc&limit=1`);
            const srows = sr.ok ? await sr.json() : [];
            if (srows[0] && srows[0].scores_json) diag.scores = srows[0].scores_json;
            if (srows[0] && srows[0].raw_markdown) diag.report_html = srows[0].raw_markdown;
          } catch (_) { /* scores are optional */ }
        }
        // Editable rater heads-up: if an approved 'rater_headsup' template exists,
        // deliver its filled text so the leader's Step-4 box shows the coach's wording.
        // Best-effort — on any miss the page falls back to its built-in copy.
        try {
          const tr = await sb(`/rest/v1/email_templates?template_key=eq.rater_headsup&is_approved=eq.true&select=body_text&limit=1`);
          const trows = tr.ok ? await tr.json() : [];
          if (trows[0] && trows[0].body_text) {
            diag.rater_headsup_text = String(trows[0].body_text).replace(/\{\{\s*leader_name\s*\}\}/gi, diag.client_name || '');
          }
        } catch (_) { /* template optional — page falls back */ }
        // Sprint conversion offer — shown from debrief_date forward.
        // Computes credit window and selects the right link/price from renewal_config.
        // Never blocks the page: any failure here is swallowed.
        if (diag.debrief_date) {
          const today      = new Date();
          const debriefDay = new Date(diag.debrief_date + 'T12:00:00');
          if (today >= debriefDay) {
            try {
              const cr = await sb('/rest/v1/renewal_config?id=eq.1&select=first_sprint_credit_url,first_sprint_standard_url,price_first_credit,price_first_standard,credit_window_days&limit=1');
              if (cr.ok) {
                const crows = await cr.json();
                const cfg   = Array.isArray(crows) && crows[0];
                if (cfg) {
                  const windowDays      = typeof cfg.credit_window_days === 'number' ? cfg.credit_window_days : 30;
                  const creditWindowEnd = new Date(debriefDay);
                  creditWindowEnd.setDate(creditWindowEnd.getDate() + windowDays);
                  const inWindow  = today <= creditWindowEnd;
                  const daysLeft  = Math.max(0, Math.ceil((creditWindowEnd - today) / 86400000));
                  const url       = inWindow ? cfg.first_sprint_credit_url : cfg.first_sprint_standard_url;
                  if (url) {
                    diag.sprint_offer = {
                      in_credit_window:    inWindow,
                      credit_window_ends:  creditWindowEnd.toISOString().split('T')[0],
                      days_left:           daysLeft,
                      price:               inWindow ? (cfg.price_first_credit || 10000) : (cfg.price_first_standard || 15000),
                      url,
                    };
                  }
                }
              }
            } catch (_) { /* sprint offer is optional — never blocks page load */ }
          }
        }

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
      case 'leader-edit-rater': {
        const diag = await diagByLeaderToken(token);
        if (!diag) return res.status(401).json({ error: 'Invalid or expired link' });
        // Only editable before invites go out for the whole diagnostic, and only
        // for a rater that hasn't been individually invited yet. Scope strictly
        // to this diagnostic's own raters so a token can't touch another's.
        if (diag.invites_sent_at) return res.status(403).json({ error: 'Invitations have been sent — the rater list is locked.' });
        const rid = body.rater_id;
        const rt  = body.rater || {};
        if (!rid) return res.status(400).json({ error: 'rater_id required' });
        if (!rt.name || !rt.email) return res.status(400).json({ error: 'name and email required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rt.email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
        // Verify the rater belongs to THIS diagnostic and isn't already invited.
        const chk = await sb(`/rest/v1/diagnostic_raters?id=eq.${enc(rid)}&diagnostic_id=eq.${diag.id}&select=id,invited_at,is_self&limit=1`);
        const chkRows = chk.ok ? await chk.json() : [];
        const existing = chkRows[0];
        if (!existing) return res.status(404).json({ error: 'Rater not found for this diagnostic' });
        if (existing.is_self) return res.status(403).json({ error: 'The self-assessment row cannot be edited here.' });
        if (existing.invited_at) return res.status(403).json({ error: 'That rater has already been invited.' });
        const upd = { name: rt.name, email: rt.email };
        if (rt.relationship) upd.relationship = rt.relationship;
        const r = await sb(`/rest/v1/diagnostic_raters?id=eq.${enc(rid)}`, 'PATCH', upd, { Prefer: 'return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not update rater', detail: d }); }
        const rows = await r.json();
        return res.status(200).json({ ok: true, rater: Array.isArray(rows) ? rows[0] : rows });
      }
      case 'leader-finalize': {
        const diag = await diagByLeaderToken(token);
        if (!diag) return res.status(401).json({ error: 'Invalid or expired link' });
        const now = new Date().toISOString();
        const r = await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH', { raters_finalized_at: now, updated_at: now }, { Prefer: 'return=minimal' });
        if (!r.ok) return res.status(500).json({ error: 'Could not submit list' });
        await maybeSendRaterBrief(diag.id);   // sends only if self-assessment is also done
        return res.status(200).json({ ok: true, raters_finalized_at: now });
      }

      // ── Rater survey page (diagnostic-survey.html) ──────────────────────────
      case 'rater-get': {
        const rater = await raterByToken(token);
        if (!rater) return res.status(401).json({ error: 'Invalid or expired link' });
        // Only the fields the survey page needs — never expose the leader's private
        // notes or self-assessment. leader_token is returned ONLY for the leader's
        // own self-assessment (so the page can redirect back to the leader portal).
        const cols = 'id,status,survey_closed_at,close_date,client_name,client_org,client_title,custom_g1_question,custom_g2_question,custom_g3_question,custom_g2_type,custom_g3_type,anonymous_feedback'
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
          await maybeSendRaterBrief(rater.diagnostic_id);   // sends only if rater list is also submitted
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
