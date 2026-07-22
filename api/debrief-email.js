// GPS Leadership — Debrief follow-up email (coach-only): draft -> review -> send
//
// The in-portal home for what the gps-debrief-followup skill does today in Gmail.
// Two actions, both coach-gated:
//   draft  -> AI-drafts the post-debrief email in Alex's voice from THIS leader's
//             captured debrief data (fail-open kill-switch; template fallback if AI
//             is off or unavailable). Returns { subject, body }. Sends NOTHING.
//   send   -> emails the (coach-reviewed, possibly edited) subject+body to the leader
//             via Resend, from "Alex Tremble - GPS Leadership", reply-to the coach.
//             Logs the send on debrief_captures. `dry_run:true` builds the payload but
//             does NOT hit Resend (used to verify wiring without emailing a client).
//
// SAFETY: the coach reviews and clicks send — this endpoint never auto-sends. It
// requires a non-empty subject+body and a leader email on file. Confidentiality:
// only the recipient's own aggregate data is fed to the draft; no individual rater
// quotes, no other leaders, no delicate perception findings (enforced in the prompt).
//
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET, ANTHROPIC_API_KEY,
//      RESEND_API_KEY, RESEND_FROM_EMAIL, CLAUDE_MODEL

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const CLAUDE_MODEL         = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
// FROM domain is PINNED to the verified Resend domain — a mis-set env pointing at an
// unverified apex would silently fail every send.
const RESEND_FROM = /@(?:[a-z0-9-]+\.)*gpsleadership\.org$/i.test(String(process.env.RESEND_FROM_EMAIL || ''))
  ? process.env.RESEND_FROM_EMAIL
  : 'noreply@portal.gpsleadership.org';

const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function firstRow(path) {
  try { const r = await sb(path); if (!r.ok) return null; const rows = await r.json(); return (Array.isArray(rows) && rows[0]) || null; }
  catch (_) { return null; }
}
function verifyCoachSession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!p || p.role !== 'coach' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}
// AI kill-switch (coach Settings -> AI Controls). Missing/unreadable row = ON (fail-open).
async function aiFeatureEnabled(feature) {
  try {
    if (!SUPABASE_SECRET) return true;
    const r = await sb(`/rest/v1/ai_feature_flags?feature=eq.${enc(feature)}&select=enabled&limit=1`);
    if (!r.ok) return true;
    const row = (await r.json())[0];
    return !row || row.enabled !== false;
  } catch (_) { return true; }
}

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const isHigh = (v) => v != null && Number(v) >= 8;

// Pull everything the email needs for ONE leader. Aggregates + the coach's own
// captured data only — never individual rater rows.
async function gatherContext(diagnosticId) {
  const diag = await firstRow(`/rest/v1/diagnostics?id=eq.${enc(diagnosticId)}&select=id,client_name,client_title,client_org,client_id,results_narrative,wizard_prefill_data&limit=1`);
  if (!diag) return { error: 'Diagnostic not found' };
  const cap = await firstRow(`/rest/v1/debrief_captures?diagnostic_id=eq.${enc(diagnosticId)}&select=*&limit=1`) || {};
  const N = diag.results_narrative || {};
  const plan = diag.wizard_prefill_data || {};
  let sponsorName = null, fundingType = cap.funding_type || null;
  // Sponsor name for the ratings-callback close, if sponsor-funded.
  if (diag.client_id) {
    try {
      const tm = await sb(`/rest/v1/team_members?client_id=eq.${enc(diag.client_id)}&select=team_id&limit=20`);
      const teams = tm.ok ? await tm.json() : [];
      const teamIds = (Array.isArray(teams) ? teams : []).map(t => t.team_id).filter(Boolean);
      if (teamIds.length) {
        const st = await sb(`/rest/v1/sponsor_teams?team_id=in.(${teamIds.map(enc).join(',')})&select=sponsor_id&limit=5`);
        const links = st.ok ? await st.json() : [];
        if (Array.isArray(links) && links.length) {
          const sp = await firstRow(`/rest/v1/sponsors?id=eq.${enc(links[0].sponsor_id)}&select=name&limit=1`);
          sponsorName = (sp && sp.name) || null;
          if (!fundingType) fundingType = 'sponsor';
        }
      }
    } catch (_) {}
  }
  if (!fundingType) fundingType = 'self';
  // Leader email (for send) from the linked client.
  let leaderEmail = null;
  if (diag.client_id) {
    const cl = await firstRow(`/rest/v1/clients?id=eq.${enc(diag.client_id)}&select=email&limit=1`);
    leaderEmail = cl && cl.email ? cl.email : null;
  }
  return {
    diag, cap, leaderEmail, fundingType, sponsorName,
    ctx: {
      leader_first: firstName(diag.client_name),
      leader_name: diag.client_name || 'this leader',
      leader_title: diag.client_title || '',
      org: diag.client_org || 'your organization',
      focus_1: N.focus1 || '',
      focus_2: N.focus2 || '',
      behavior: plan.start_behavior || plan.behavior_1 || plan.behavior || '',
      metric_name: plan.metric_name || plan.metric_1_name || '',
      value_end: cap.value_end != null ? Number(cap.value_end) : null,
      appetite: cap.appetite != null ? Number(cap.appetite) : null,
      outcome: cap.outcome || null,
      coach_notes: (cap.notes || '').slice(0, 1200),
      funding_type: fundingType,
      sponsor_name: sponsorName || '',
    },
  };
}

function draftSystemPrompt() {
  return [
    "You are drafting the post-debrief follow-up email that Alex Tremble sends a leader right after their GPS Leadership 14-Day Executive Leadership Diagnostic debrief. Write it as Alex, first person.",
    "",
    "PURPOSE: confirm commitments in writing, frame phase one (assessment) vs phase two (implementation), and open the door to the 90-day sprint without pitching.",
    "",
    "STRUCTURE (follow in order, reworded naturally per leader):",
    "1. Warm, specific open. Thank them and name something real: the time they gave, that they looked hard at feedback that was not easy. One line on why that matters. Never generic praise.",
    "2. 'Here is what we agreed on, so we both have it in writing:' then 3-5 action-first bullets of the LEADER'S commitments. Use ONLY commitments present in the coach notes provided. If none are provided, write a single bracketed placeholder like [Alex: list the commitments you two agreed on] instead of inventing any.",
    "3. One short past-tense paragraph on what Alex has already delivered/set up (their report and 90-day plan are in their portal).",
    "4. Phase framing: phase one is assessment — it tells you where you stand and where your energy is best spent; it is diagnostic, not transformational. Phase two is where the change happens — you implement, watch what works, and adjust in real time; that is what coaching is for and where the score movement comes from.",
    "5. The offer, ONE paragraph, no hard sell: the 90-day sprint is a three-month commitment, a call every other week, structured support toward the goals set in the debrief plus in-the-moment coaching between sessions. Do NOT put any dollar figures or prices in the email.",
    "6. Soft close on the decision. If sponsor-funded, route it to the sponsor: 'I would be glad to support you through that if you and [sponsor] decide it is the right direction.' Never push.",
    "7. Ratings callback ONLY if the leader rated highly (8+). Name the numbers as numerals (a 9 out of 10). Say Alex will share the numbers with the sponsor when they next meet (FUTURE tense — use a [sponsor meeting date] placeholder), invite them to tell the sponsor directly if they want to continue, and note the sponsor decides where to invest. If no high ratings were captured, omit this section entirely.",
    "8. Warm sign-off as Alex.",
    "",
    "VOICE: first person, direct, warm, calm. Short sentences. No em dashes. No emojis. No corporate buzzwords. Never use the words 'genuinely', 'honestly', or 'straightforward'. Do not oversell.",
    "",
    "GUARDRAILS (hard):",
    "- Use ONLY the recipient's own aggregate data provided below. Never include another leader's results, any individual rater's words, or delicate perception findings.",
    "- Never assert a specific date or a commitment that is not in the provided notes. Use a [bracketed placeholder] for anything you do not have, so Alex fills it in on review.",
    "- No pricing figures anywhere in the email.",
    "",
    "OUTPUT FORMAT (exactly this, nothing else): the first line must be 'SUBJECT: ' followed by a short subject line. Then a line with only '---'. Then the plain-text email body (no markdown, no bold, real line breaks between paragraphs).",
  ].join("\n");
}

function draftUserPayload(ctx) {
  const ratingsNote = (isHigh(ctx.value_end) || isHigh(ctx.appetite))
    ? `The leader rated the debrief a ${ctx.value_end != null ? ctx.value_end : '[n/a]'} out of 10 for value today, and a ${ctx.appetite != null ? ctx.appetite : '[n/a]'} out of 10 for how helpful 90 days of support would be. Include the ratings callback (section 7).`
    : `No high ratings were captured — OMIT the ratings callback (section 7) entirely.`;
  return [
    "Draft the follow-up email for this leader. Data (use only what is here; bracket anything missing):",
    "",
    `Leader: ${ctx.leader_name}${ctx.leader_title ? ', ' + ctx.leader_title : ''} at ${ctx.org}. Address them as ${ctx.leader_first}.`,
    `Their 90-day focus: ${ctx.focus_1 || '[Alex: their focus]'}${ctx.focus_2 ? ' (secondary: ' + ctx.focus_2 + ')' : ''}.`,
    ctx.behavior ? `The behavior/metric they are working: ${ctx.behavior}${ctx.metric_name ? ' / ' + ctx.metric_name : ''}.` : '',
    `Funding: ${ctx.funding_type}${ctx.sponsor_name ? ' (sponsor: ' + ctx.sponsor_name + ')' : ''}. ${ctx.funding_type === 'sponsor' ? 'Route the decision to the sponsor in section 6; use their name.' : 'The leader is the decision-maker.'}`,
    "",
    ratingsNote,
    "",
    ctx.coach_notes ? `Coach notes from the debrief (source of the agreed commitments — use these, do not invent others):\n${ctx.coach_notes}` : "No coach notes were captured — use a bracketed placeholder for the agreed commitments in section 2.",
  ].filter(Boolean).join("\n");
}

// Deterministic fallback when AI is off / unavailable — same skeleton, bracketed
// where the model would have written prose, so the feature never hard-fails.
function templateDraft(ctx) {
  const subject = `Following up on our debrief, ${ctx.leader_first}`;
  const lines = [];
  lines.push(`Hi ${ctx.leader_first},`);
  lines.push('');
  lines.push(`Thank you for the time and the openness today. Looking hard at this kind of feedback is not easy, and you did it well. [Alex: one specific, observed line here.]`);
  lines.push('');
  lines.push('Here is what we agreed on, so we both have it in writing:');
  lines.push('[Alex: list the 3-5 commitments you two landed on]');
  lines.push('');
  lines.push('Your report and your 90-day plan are already in your portal, so you have one place for all of it.');
  lines.push('');
  lines.push('A quick frame. Phase one is the assessment. It tells you where you stand and where your energy is best spent. It is diagnostic, not transformational. Phase two is where the change actually happens. You implement, watch what is working and what is not, and adjust in real time. That is what coaching is for, and where the score movement comes from.');
  lines.push('');
  lines.push('If it is useful, the next step is a 90-day sprint: a three-month commitment, a call every other week, structured support toward the goals we set today plus in-the-moment coaching between sessions.');
  lines.push('');
  if (ctx.funding_type === 'sponsor' && ctx.sponsor_name) {
    lines.push(`I would be glad to support you through that if you and ${ctx.sponsor_name} decide it is the right direction.`);
  } else {
    lines.push('I would be glad to support you through that if you decide it is the right direction.');
  }
  if (isHigh(ctx.value_end) || isHigh(ctx.appetite)) {
    lines.push('');
    const bits = [];
    if (ctx.value_end != null) bits.push(`a ${ctx.value_end} out of 10 on the value of our time today`);
    if (ctx.appetite != null) bits.push(`a ${ctx.appetite} out of 10 on how helpful the next 90 days would be`);
    lines.push(`One more thing. You gave ${bits.join(' and ')}. When I meet with ${ctx.sponsor_name || '[sponsor]'} on [date], I will share those numbers with them, and I hope you do not mind. If you would like to keep going, it helps for them to hear it from you too. They decide where to invest.`);
  }
  lines.push('');
  lines.push('Talk soon,');
  lines.push('Alex');
  return { subject, body: lines.join('\n') };
}

function parseDraft(text) {
  const s = String(text || '').trim();
  const m = s.match(/^SUBJECT:\s*(.+?)\s*\n+---\s*\n+([\s\S]+)$/i);
  if (m) return { subject: m[1].trim(), body: m[2].trim() };
  // Fallback parse: first line as subject if it looks like one.
  const nl = s.indexOf('\n');
  if (nl > 0 && /subject/i.test(s.slice(0, nl))) return { subject: s.slice(0, nl).replace(/^SUBJECT:\s*/i, '').trim(), body: s.slice(nl + 1).trim() };
  return { subject: 'Following up on our debrief', body: s };
}

function bodyToHtml(text) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(text || '').trim().split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:8px 4px;color:#1a1a1a;font-size:15px;line-height:1.6;">${paras}</div>`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.ping === '1') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ ok: true, ping: true }); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body = req.body || {};
  const session = verifyCoachSession(body.session);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  const coachEmail = session.em || 'alex@gpsleadership.org';
  const coachName = session.nm || 'Alex Tremble';
  const coachFirst = firstName(coachName);
  const diagnosticId = String(body.diagnostic_id || '').trim();
  if (!diagnosticId) return res.status(400).json({ error: 'diagnostic_id required' });

  try {
    if (body.action === 'draft') {
      const g = await gatherContext(diagnosticId);
      if (g.error) return res.status(404).json({ error: g.error });

      const aiOn = (await aiFeatureEnabled('debrief_followup')) && !!ANTHROPIC_API_KEY;
      if (!aiOn) {
        const t = templateDraft(g.ctx);
        return res.status(200).json({ ok: true, ai_used: false, subject: t.subject, body: t.body, leader_email: g.leaderEmail, funding_type: g.fundingType });
      }
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: CLAUDE_MODEL, max_tokens: 1400,
            system: draftSystemPrompt(),
            messages: [{ role: 'user', content: draftUserPayload(g.ctx) }],
          }),
        });
        if (!resp.ok) throw new Error('AI draft failed (' + resp.status + ')');
        const data = await resp.json();
        const text = (data && data.content && data.content[0] && data.content[0].text) || '';
        const parsed = parseDraft(text);
        if (!parsed.body) throw new Error('Empty AI draft');
        return res.status(200).json({ ok: true, ai_used: true, subject: parsed.subject, body: parsed.body, leader_email: g.leaderEmail, funding_type: g.fundingType });
      } catch (e) {
        // Never hard-fail — hand back the template so the coach still has a starting point.
        const t = templateDraft(g.ctx);
        return res.status(200).json({ ok: true, ai_used: false, ai_error: (e && e.message) || 'AI unavailable', subject: t.subject, body: t.body, leader_email: g.leaderEmail, funding_type: g.fundingType });
      }
    }

    if (body.action === 'send') {
      const subject = String(body.subject || '').trim();
      const emailBody = String(body.body || '').trim();
      if (!subject) return res.status(400).json({ error: 'A subject is required.' });
      if (!emailBody) return res.status(400).json({ error: 'The email body is empty.' });

      const g = await gatherContext(diagnosticId);
      if (g.error) return res.status(404).json({ error: g.error });
      const to = g.leaderEmail;
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return res.status(400).json({ error: 'No valid email on file for this leader. Add their email on the client profile, then resend.' });
      }

      const payload = {
        from: `${coachName} - GPS Leadership <${RESEND_FROM}>`,
        to: [to],
        reply_to: coachEmail,
        subject,
        html: bodyToHtml(emailBody),
      };

      // dry_run: verify wiring without emailing a real client.
      if (body.dry_run) {
        return res.status(200).json({ ok: true, dry_run: true, would_send: { to, from: payload.from, reply_to: payload.reply_to, subject, html_len: payload.html.length } });
      }
      if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email is not configured on the server (missing RESEND_API_KEY).' });

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return res.status(502).json({ error: 'The email provider rejected the send. Nothing was sent.', detail: d });
      }
      const sent = await r.json().catch(() => ({}));
      const now = new Date().toISOString();
      // Best-effort send-log on the capture row (idempotency + audit). Never blocks the success.
      try {
        await sb('/rest/v1/debrief_captures?on_conflict=diagnostic_id', 'POST',
          { diagnostic_id: diagnosticId, followup_sent_at: now, followup_to: to, followup_subject: subject, updated_at: now },
          { Prefer: 'resolution=merge-duplicates,return=minimal' });
      } catch (_) {}
      return res.status(200).json({ ok: true, sent_to: to, sent_at: now, provider_id: sent && sent.id });
    }

    return res.status(400).json({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
