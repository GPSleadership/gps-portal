import crypto from 'node:crypto';
// GPS Leadership Solutions — Diagnostic API (consolidated)
// Routes all diagnostic actions through a single serverless function.
//
// POST /api/diagnostic?action=send-invites      — send rater invite emails
// POST /api/diagnostic?action=send-leader-link  — email leader their self-assessment portal link
// POST /api/diagnostic?action=generate-question — generate custom G1 question via Claude
// POST /api/diagnostic?action=generate-report   — generate full TP3 report via Claude
// GET|POST /api/diagnostic?action=reminders     — cron: rater reminders + T-2 alerts + auto-lock
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_SECRET_KEY   — Supabase service role key (server-side; bypasses RLS)
//   RESEND_API_KEY        — Resend API key
//   RESEND_FROM_EMAIL     — Sending address (default: noreply@portal.gpsleadership.org)
//   PORTAL_BASE_URL       — Portal base URL (default: https://portal.gpsleadership.org)
//   ANTHROPIC_API_KEY     — Claude API key (required for generate-question + generate-report)
//   COACH_ALERT_EMAIL     — Alert recipient (default: alex@gpsleadership.org)
//   CRON_SECRET           — Optional: protect manual reminders trigger

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://pbnkefuqpoztcxfagiod.supabase.co';
// Phase 1: server-side functions use the SERVICE ROLE key (bypasses RLS) so they
// keep working after the v26 anon-policy lockdown. Never expose this to the browser.
const SUPABASE_KEY      = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON;

// Record a successful cron run so detect_breakages can flag a job that goes silent.
async function recordHeartbeat(name, status = 'ok', detail = null) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeats?on_conflict=cron_name`, {
      method:  'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cron_name: name, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail, updated_at: new Date().toISOString() }),
    });
  } catch (_) { /* best-effort */ }
}
if (!SUPABASE_KEY) throw new Error('diagnostic.js: missing SUPABASE_SECRET_KEY — refusing to start with no service key');
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM       = process.env.RESEND_FROM_EMAIL   || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE       = process.env.PORTAL_BASE_URL     || 'https://portal.gpsleadership.org';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COACH_EMAIL       = process.env.COACH_ALERT_EMAIL   || 'alex@gpsleadership.org';
// Replies should reach a human (deliverability + legitimacy signal). Override with RESEND_REPLY_TO.
const REPLY_TO          = process.env.RESEND_REPLY_TO     || COACH_EMAIL;
const CRON_SECRET       = process.env.CRON_SECRET;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

// Verify a coach session token (HMAC) for authenticated manual cron triggers.
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

const CLAUDE_MODEL        = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CLAUDE_REPORT_MODEL = process.env.CLAUDE_REPORT_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'; // Full-quality report model — requires Vercel Pro (120s timeout)

// ── Supabase fetch helper ────────────────────────────────────────────────────
function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Call Claude API (with retry) ─────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, maxTokens = 512, { retries = 2, retryDelayMs = 3000, model = CLAUDE_MODEL, timeoutMs = null, temperature = null, documentBase64 = null, documentMediaType = 'application/pdf' } = {}) {
  // When a PDF is supplied, send it as a document block alongside the text so the
  // model reads the actual uploaded report (no server-side PDF parsing needed).
  const userContent = documentBase64
    ? [ { type: 'document', source: { type: 'base64', media_type: documentMediaType, data: documentBase64 } }, { type: 'text', text: userPrompt } ]
    : userPrompt;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[callClaude] retry attempt ${attempt} after ${retryDelayMs}ms…`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
    try {
      const fetchOpts = {
        method: 'POST',
        headers: {
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        body: JSON.stringify({
          model:      model,
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          ...(temperature != null ? { temperature } : {}),
        }),
      };
      if (timeoutMs) fetchOpts.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch('https://api.anthropic.com/v1/messages', fetchOpts);
      // Retry on 529 (overloaded) or 500; surface other errors immediately
      if (res.status === 529 || res.status === 500) {
        const errText = await res.text();
        lastErr = new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
        continue; // retry
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json();
      return data.content?.[0]?.text?.trim() || '';
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr;
}

// ── Log email ────────────────────────────────────────────────────────────────
async function logEmail({ recipientEmail, recipientName, emailType, subject, status, errorDetails, resendId }) {
  try {
    await sb('/rest/v1/email_log', 'POST',
      {
        recipient_email: recipientEmail,
        recipient_name:  recipientName || null,
        email_type:      emailType,
        subject:         subject || null,
        status,
        error_details:   errorDetails ? JSON.stringify(errorDetails) : null,
        resend_id:       resendId || null,
      },
      { Prefer: 'return=minimal' }
    );
  } catch (_) {}
}

// ── Send email via Resend ────────────────────────────────────────────────────
// Derive a readable plaintext version from the HTML so every send is multipart.
// HTML-only email is a spam signal; a real text/plain part improves inbox placement.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Configurable CC for diagnostic emails. Reads the global email_cc_settings and honors
// the Option A rule: the leader is never CC'd on anonymous diagnostics, even if the
// "CC leader" toggle is on (protects rater candor). Falls back to leader+team+alex.
async function loadCcConfig() {
  try {
    const r = await sb('/rest/v1/email_cc_settings?id=eq.1&select=cc_leader,cc_team,cc_alex,extra_cc&limit=1');
    if (r.ok) { const rows = await r.json(); if (Array.isArray(rows) && rows[0]) return rows[0]; }
  } catch (_) {}
  return { cc_leader: true, cc_team: true, cc_alex: true, extra_cc: [] };
}
// Leader CC is stage-based. Default: the leader is copied ONLY on the FIRST email (the
// invite), for credibility — raters see their leader is genuinely behind this. The invite
// goes to ALL raters before anyone has responded, so it reveals nothing about who has or
// hasn't completed. The leader is deliberately NOT copied on the mid/final reminders:
// those go only to people who haven't finished, so copying the leader there would expose
// the non-completer list.
//
// Exception: a diagnostic flagged `cc_leader_first_reminder` also copies the leader on the
// FIRST reminder. This is the catch-up for cohorts whose invite already went out without
// the leader (e.g. JMAA): the first reminder fires early (~T-3), when almost no one has
// completed yet, so the non-completer list is still essentially the whole roster and
// reveals little — while still getting the leader onto a rater-facing thread.
//
// Decoupled from anonymous_feedback on purpose — that flag governs whether individual
// RATINGS are shown, not whether the leader appears on a thread. Ratings stay anonymous
// regardless. team@/alex@/extra_cc are unchanged for every stage.
// Leader-eligible stages: 'invite' always; 'reminder_1' only when the flag is set.
function buildDiagCc(cfg, diag, stage) {
  const out = [];
  const leaderOnInvite        = (stage === 'invite');
  const leaderOnFirstReminder = (stage === 'reminder_1' && diag.cc_leader_first_reminder === true);
  if (cfg.cc_leader && (leaderOnInvite || leaderOnFirstReminder) && diag.client_email) out.push(diag.client_email);
  if (cfg.cc_team) out.push('team@gpsleadership.org');
  if (cfg.cc_alex) out.push('alex@gpsleadership.org');
  if (Array.isArray(cfg.extra_cc)) cfg.extra_cc.forEach(e => out.push(e));
  return out.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
}

async function sendEmail({ to, subject, html, text, emailType, recipientName, cc, client, brandUrl }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  // Auto-link the first "GPS Leadership Solutions" mention to the segment-appropriate page.
  try {
    const { gpsDiagnosticLink, autoLinkBrand } = require('./brand-link');
    html = autoLinkBrand(html, brandUrl || gpsDiagnosticLink(client));
  } catch (_) { /* never block a send on branding */ }
  const payload = {
    from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`,
    to: [to],
    subject,
    html,
    text: text || htmlToText(html),   // multipart: text/plain alongside HTML
    reply_to: REPLY_TO,               // replies reach a human, not a black hole
  };
  if (cc && cc.length > 0) payload.cc = cc;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!res.ok) {
    await logEmail({ recipientEmail: to, recipientName, emailType, subject, status: 'error', errorDetails: result });
    throw new Error(`Resend error: ${JSON.stringify(result)}`);
  }
  await logEmail({ recipientEmail: to, recipientName, emailType, subject, status: 'sent', resendId: result.id });
  return result.id;
}

// ── Editable email templates ────────────────────────────────────────────────
// Send copy is editable under Communication → Email Templates. Each diagnostic
// send tries its APPROVED template (subject + body paragraphs); if none is
// approved, it falls back to the built-in copy below — so nothing changes until a
// template is reviewed and approved. Body text uses {{variable}} placeholders and
// blank-line-separated paragraphs; the surrounding branded shell + buttons stay.
const _diagTplCache = {};
async function getApprovedTemplate(templateKey) {
  if (_diagTplCache[templateKey] !== undefined) return _diagTplCache[templateKey];
  let tpl = null;
  try {
    const r = await sb(`/rest/v1/email_templates?template_key=eq.${encodeURIComponent(templateKey)}&is_approved=eq.true&select=subject,body_text&limit=1`);
    if (r.ok) { const d = await r.json(); tpl = (Array.isArray(d) && d[0]) ? d[0] : null; }
  } catch (_) { tpl = null; }
  _diagTplCache[templateKey] = tpl;
  return tpl;
}
function fillTemplate(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => (vars && vars[k] != null) ? String(vars[k]) : '');
}
// Template body → HTML. Lines become <p> paragraphs (blank lines separate, as before).
// Lightweight, coach-authored markdown-style formatting is supported and is fully
// backward compatible: bodies with no markers render byte-identically to the old
// version. Markers (markers must hug their text — "**bold**" not "** bold **" — so
// stray asterisks in math/copy are never mistaken for formatting):
//   **bold**  *italic*  __underline__   |   "- " bullet lines   |   "> " indented line
function tplBodyToHtml(text) {
  function inline(s) {
    return s
      .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '<span style="text-decoration:underline;">$1</span>')
      .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>');
  }
  const lines = String(text || '').split(/\n/);
  let html = '', buf = [];
  function flush() {
    if (buf.length) {
      html += '<ul style="margin:0 0 14px;padding-left:22px;">' + buf.map(function (li) { return '<li style="margin:0 0 6px;">' + inline(li) + '</li>'; }).join('') + '</ul>';
      buf = [];
    }
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) { buf.push(b[1]); continue; }
    flush();
    const ind = line.match(/^>\s+(.*)$/);
    if (ind) { html += '<p style="margin:0 0 14px;padding-left:22px;">' + inline(ind[1]) + '</p>'; continue; }
    html += '<p style="margin:0 0 14px;">' + inline(line) + '</p>';
  }
  flush();
  return html;
}

// ── Kickoff recap email (draft → review/edit → send) ─────────────────────────
// After a kickoff/intake call, the coach can draft a recap email to the leader from
// the intake notes, review/edit it, then copy or send. The AI prompt itself is an
// EDITABLE template (Communication > Templates, key "kickoff_email_prompt"), so Alex
// can tune how these emails are written without a code change.
const KICKOFF_EMAIL_PROMPT_DEFAULT = `You are drafting a short follow-up email FROM Alex Tremble (GPS Leadership Solutions) TO a leader who just completed their kickoff / intake call for a 14-Day Executive Leadership Diagnostic. Write in Alex's voice: direct, warm, candid, plain language, short sentences. No corporate buzzwords. No hype. Do not use em dashes; use a comma, period, or semicolon instead.

Use ONLY the kickoff notes and leader context provided. Do not invent facts, commitments, dates, or names that are not in the notes. If something is unclear, keep it general rather than guessing.

The email should:
- Open warmly and thank them for the kickoff conversation.
- Briefly reflect back what you heard: their situation, what they want to change, and the focus for the diagnostic (2 to 4 sentences, specific to the notes).
- Confirm the next step in plain terms: they complete their self-assessment and add their rater list, then GPS runs the confidential 360.
- Close with a short line of encouragement.

Keep it tight: roughly 150 to 250 words. Do NOT include a sign-off or signature (it is added automatically). Do not put a subject line inside the body.

Return ONLY valid JSON in this exact shape, nothing else:
{"subject": "a short, specific subject line", "body_text": "the email body as plain paragraphs separated by blank lines; you may use \"- \" at the start of a line for a bullet"}`;

function kickoffEmailShell(inner) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
    <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
      <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;">A note after our kickoff</div>
    </div>
    <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
      ${inner}
      <p style="margin-top:28px;">– Alex Tremble<br><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
    </div>
  </div>`;
}

async function handleDraftKickoffEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=client_name,client_title,client_org,intake_notes,intake_transcript_url,goal_description,goal_statement,tp3_pillar&limit=1`);
    const rows = r.ok ? await r.json() : [];
    const d = rows[0];
    if (!d) return res.status(404).json({ error: 'Diagnostic not found' });
    if (!d.intake_notes && !d.intake_transcript_url) {
      return res.status(400).json({ error: 'Add kickoff / intake notes (or a transcript link) on this diagnostic first, then draft the email.' });
    }
    const firstName = String(d.client_name || '').trim().split(/\s+/)[0] || 'there';
    const vars = { first_name: firstName, leader_name: d.client_name || '', leader_title: d.client_title || '', org: d.client_org || '' };

    const promptTpl = await getApprovedTemplate('kickoff_email_prompt');
    const systemPrompt = (promptTpl && promptTpl.body_text)
      ? fillTemplate(promptTpl.body_text, vars)
      : KICKOFF_EMAIL_PROMPT_DEFAULT;

    const ctx = [
      `Leader: ${d.client_name || ''}${d.client_title ? ', ' + d.client_title : ''}${d.client_org ? ' (' + d.client_org + ')' : ''}`,
      d.tp3_pillar ? `Focus pillar: ${d.tp3_pillar}` : '',
      d.goal_description ? `Stated goal: ${d.goal_description}` : '',
      d.goal_statement ? `90-day goal: ${d.goal_statement}` : '',
      '',
      'KICK-OFF / INTAKE NOTES:',
      d.intake_notes || '(no typed notes; see transcript)',
      d.intake_transcript_url ? `\n(Transcript link for your reference only, not for the leader: ${d.intake_transcript_url})` : '',
    ].filter(Boolean).join('\n');

    const raw = await callClaude(systemPrompt, ctx, 1600, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, temperature: 0.3, retries: 1 });
    const parsed = parseJsonLoose(raw);
    const subject = (parsed && parsed.subject) ? String(parsed.subject) : `Following up on our kickoff, ${firstName}`;
    const body_text = (parsed && parsed.body_text) ? String(parsed.body_text) : String(raw || '').trim();
    if (!body_text) return res.status(502).json({ error: 'Could not draft the email. Please try again.' });
    return res.status(200).json({ ok: true, subject, body_text });
  } catch (e) {
    return res.status(502).json({ error: 'Could not draft the email. Please try again.' });
  }
}

async function handleSendKickoffEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session, subject, body_text } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id || !subject || !body_text) return res.status(400).json({ error: 'diagnostic_id, subject and body_text are required' });
  try {
    const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=client_id,client_name,client_email&limit=1`);
    const rows = r.ok ? await r.json() : [];
    const d = rows[0];
    if (!d) return res.status(404).json({ error: 'Diagnostic not found' });
    if (!d.client_email) return res.status(400).json({ error: 'No leader email is on file for this diagnostic.' });
    const html = kickoffEmailShell(tplBodyToHtml(String(body_text)));
    await sendEmail({ to: d.client_email, subject: String(subject), html, emailType: 'kickoff_recap', recipientName: d.client_name || '' });
    return res.status(200).json({ ok: true, sent_to: d.client_email });
  } catch (e) {
    return res.status(502).json({ error: 'Could not send the email. ' + (e.message || '') });
  }
}

// ── Consolidated rater nudge (peer-feedback) ─────────────────────────────────
// One email per rater covering EVERY leader they rate in an org's open cohort, with
// completed (green) vs outstanding (red + link) status. Raises completion by showing
// progress ("2 of 4 done") instead of scattering separate emails per leader.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; });
}
function buildConsolidatedNudgeEmail(rater, done, cohortClose) {
  const first = (rater.name || '').split(' ')[0] || 'there';
  const items = rater.items;
  const total = items.length;
  const outstanding = total - done;
  const closeFmt = cohortClose ? new Date(cohortClose + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'soon';
  const subject = done > 0
    ? `You're partway. ${outstanding} left to rate.`
    : `Your leadership feedback: ${total} ${total === 1 ? 'person' : 'people'} to rate`;
  const intro = done > 0
    ? `Thanks for the feedback you've already shared. You're ${done} of ${total} done, ${outstanding} to go, about 15 minutes each. Your answers stay anonymous. Scores are averaged across raters and comments never carry a name.`
    : `You've been asked to give confidential feedback on ${total} ${total === 1 ? 'leader' : 'leaders'} as part of their GPS Leadership Solutions diagnostic. About 15 minutes each. Your answers stay anonymous. Scores are averaged across raters and comments never carry a name.`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const progressBar = done > 0
    ? `<tr><td style="padding:4px 0 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#eef1f2;border-radius:20px;"><table role="presentation" width="${pct}%" cellpadding="0" cellspacing="0"><tr><td style="background:#0F6E56;height:8px;border-radius:20px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table><div style="font-size:12px;color:#5a6b76;margin-top:5px;font-weight:700;">${done} of ${total} done</div></td></tr>`
    : '';
  const rows = items.slice().sort(function (a, b) { return (b.completed ? 1 : 0) - (a.completed ? 1 : 0); }).map(function (it) {
    if (it.completed) {
      return `<tr><td style="padding:7px 0;font-size:15px;color:#5a6b76;">${escHtml(it.leader)}</td><td align="right" style="padding:7px 0;"><span style="background:#0F6E56;color:#ffffff;border-radius:6px;padding:6px 13px;font-size:13px;font-weight:700;">&#10003; Completed</span></td></tr>`;
    }
    const link = `${PORTAL_BASE}/diagnostic-survey?token=${encodeURIComponent(it.token)}`;
    return `<tr><td style="padding:7px 0;font-size:15px;color:#1a1a1a;font-weight:700;">${escHtml(it.leader)}</td><td align="right" style="padding:7px 0;"><a href="${link}" style="background:#DB1F48;color:#ffffff;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;text-decoration:none;display:inline-block;">Give feedback</a></td></tr>`;
  }).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
    <div style="background:#004369;color:#ffffff;padding:14px 22px;font-size:14px;font-weight:700;border-radius:10px 10px 0 0;">GPS Leadership Solutions &middot; Executive Leadership Diagnostic</div>
    <div style="border:1px solid #e6e6e6;border-top:none;border-radius:0 0 10px 10px;padding:22px;">
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${escHtml(first)},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">${intro}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${progressBar}${rows}</table>
      <p style="font-size:15px;line-height:1.6;margin:18px 0 0;">Everything closes ${closeFmt}. ${outstanding > 0 ? 'Finish the rest and you\'re done.' : ''}</p>
      <p style="font-size:15px;line-height:1.6;margin:16px 0 0;">Thank you. This is the feedback that makes the coaching real.</p>
      <p style="font-size:15px;line-height:1.6;margin:16px 0 0;">Alex Tremble<br>GPS Leadership Solutions</p>
    </div>
    <p style="font-size:12px;color:#8a97a0;text-align:center;margin:14px 0 0;">Button not opening? Some workplace email systems block links. Reply to this email and we'll send your links directly.</p>
  </div>`;
  const textLines = items.map(function (it) { return it.completed ? `${it.leader}: completed` : `${it.leader}: ${PORTAL_BASE}/diagnostic-survey?token=${it.token}`; });
  const text = `${first},\n\n${intro}\n\n${textLines.join('\n')}\n\nEverything closes ${closeFmt}.\n\nThank you.\nAlex Tremble\nGPS Leadership Solutions`;
  return { subject, html, text };
}
// Core: build the per-rater consolidated peer-feedback nudge for an org and (unless
// dryRun) send one email per rater. Callable from the coach HTTP action AND from the
// server-side scheduler — so a scheduled send fires with no coach logged in. No auth
// here; callers are responsible for authorization.
async function sendConsolidatedNudge(clientOrg, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const testTo = (opts.testTo || '').toString().trim();
  const dRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&client_org=ilike.${encodeURIComponent('*' + clientOrg + '*')}&select=id,client_name,close_date,client_org`);
  const diags = dRes.ok ? await dRes.json() : [];
  if (!diags.length) return { ok: true, cohort: clientOrg, leaders: 0, raters: 0, results: [], message: 'No open diagnostics for that organization.' };
  const leaderById = {}; diags.forEach(function (d) { leaderById[d.id] = d; });
  const diagIds = diags.map(function (d) { return d.id; });
  const closes = diags.map(function (d) { return d.close_date; }).filter(Boolean).sort();
  const cohortClose = closes[0] || null;
  const rRes = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=in.(${diagIds.map(encodeURIComponent).join(',')})&is_self=eq.false&invited_at=not.is.null&select=id,name,email,token,completed_at,diagnostic_id,email_bounced`);
  const raters = rRes.ok ? await rRes.json() : [];
  const byEmail = {};
  for (const r of raters) {
    if (!r.email || r.email_bounced) continue;
    const key = r.email.toLowerCase();
    if (!byEmail[key]) byEmail[key] = { name: r.name, email: r.email, items: [] };
    byEmail[key].items.push({ leader: (leaderById[r.diagnostic_id] || {}).client_name || 'a leader', completed: !!r.completed_at, token: r.token });
  }
  // Test send: model one real rater's version and deliver it only to the given address.
  if (testTo) {
    let demo = null, fallback = null;
    for (const key of Object.keys(byEmail)) {
      const r = byEmail[key];
      const d = r.items.filter(function (i) { return i.completed; }).length;
      const o = r.items.length - d;
      if (o === 0) continue;
      if (!fallback) fallback = { rater: r, done: d, outstanding: o };
      if (d > 0 && o > 0) { demo = { rater: r, done: d, outstanding: o }; break; }
    }
    const pick = demo || fallback;
    if (!pick) return { ok: true, test_to: testTo, message: 'No outstanding raters to model a test email on.' };
    const em = buildConsolidatedNudgeEmail(pick.rater, pick.done, cohortClose);
    await sendEmail({ to: testTo, subject: em.subject, html: em.html, text: em.text, emailType: 'diagnostic_consolidated_nudge_test', recipientName: pick.rater.name });
    return { ok: true, test_to: testTo, modeled_on: pick.rater.name, done: pick.done, outstanding: pick.outstanding, subject: em.subject };
  }
  const results = [];
  for (const key of Object.keys(byEmail)) {
    const rater = byEmail[key];
    const done = rater.items.filter(function (i) { return i.completed; }).length;
    const outstanding = rater.items.length - done;
    if (outstanding === 0) { results.push({ email: rater.email, name: rater.name, done, outstanding: 0, skipped: 'all complete' }); continue; }
    const email = buildConsolidatedNudgeEmail(rater, done, cohortClose);
    if (dryRun) { results.push({ email: rater.email, name: rater.name, done, outstanding, subject: email.subject, leaders: rater.items.map(function (i) { return i.leader + (i.completed ? ' (done)' : ' (open)'); }) }); continue; }
    try {
      await sendEmail({ to: rater.email, subject: email.subject, html: email.html, text: email.text, emailType: 'diagnostic_consolidated_nudge', recipientName: rater.name, cc: ['team@gpsleadership.org'] });
      results.push({ email: rater.email, name: rater.name, sent: true, done, outstanding });
    } catch (e) { results.push({ email: rater.email, error: e.message }); }
  }
  const sent = results.filter(function (r) { return r.sent; }).length;
  const skipped = results.filter(function (r) { return r.skipped; }).length;
  return { ok: true, cohort: clientOrg, dry_run: dryRun, leaders: diags.length, raters: Object.keys(byEmail).length, sent, skipped, results };
}

async function handleConsolidatedRaterNudge(req, res) {
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' });
  const clientOrg = (req.body?.client_org || '').toString().trim();
  if (!clientOrg) return res.status(400).json({ error: 'client_org is required' });
  try {
    const out = await sendConsolidatedNudge(clientOrg, { dryRun: !!req.body?.dry_run, testTo: (req.body?.test_to || '').toString().trim() });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'Could not send the nudge. ' + (e.message || '') });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-cron');
    return res.status(200).end();
  }

  if (req.query && req.query.ping !== undefined) return res.status(200).json({ ok: true, warm: true }); // cron warm-ping: keep hot, no auth/DB
  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'send-invites':         return handleSendInvites(req, res);
    case 'schedule-invites':     return handleScheduleInvites(req, res);
    case 'send-scheduled':       return handleSendScheduled(req, res);
    case 'trial-sweep':          return handleTrialSweep(req, res);
    case 'send-leader-link':     return handleSendLeaderLink(req, res);
    case 'resend-rater':         return handleResendRater(req, res);
    case 'consolidated-rater-nudge': return handleConsolidatedRaterNudge(req, res);
    case 'generate-question':    return handleGenerateQuestion(req, res);
    case 'generate-g2-question': return handleGenerateG2Question(req, res);
    case 'generate-report':      return handleGenerateReport(req, res);
    case 'save-rater-group-labels': return handleSaveRaterGroupLabels(req, res);
    case 'import-survey-data':   return handleImportSurveyData(req, res);
    case 'generate-team-report': return handleGenerateTeamReport(req, res);
    case 'finalize-report':      return handleFinalizeReport(req, res);
    case 'sign-report-upload':   return handleSignReportUpload(req, res);
    case 'sign-team-report-upload': return handleSignTeamReportUpload(req, res);
    case 'save-results-narrative':  return handleSaveResultsNarrative(req, res);
    case 'get-report-doc':          return handleGetReportDoc(req, res);
    case 'save-report-doc':         return handleSaveReportDoc(req, res);
    case 'generate-report-section': return handleGenerateReportSection(req, res);
    case 'generate-plan-prefill':   return handleGeneratePlanPrefill(req, res);
    case 'generate-dr-content':  return handleGenerateDRContent(req, res);
    case 'generate-recommendations': return handleGenerateRecommendations(req, res);
    case 'nudge-checkin':        return handleNudgeCheckin(req, res);
    case 'request-external-feedback': return handleRequestExternalFeedback(req, res);
    case 'feedback-context':     return handleFeedbackContext(req, res);
    case 'submit-external-feedback': return handleSubmitExternalFeedback(req, res);
    case 'reminders':            return handleReminders(req, res);
    case 'draft-kickoff-email':  return handleDraftKickoffEmail(req, res);
    case 'send-kickoff-email':   return handleSendKickoffEmail(req, res);
    case 'generate-email-drafts':  return handleGenerateEmailDrafts(req, res);
    case 'get-email-drafts':       return handleGetEmailDrafts(req, res);
    case 'update-email-draft':     return handleUpdateEmailDraft(req, res);
    case 'approve-email-sequence':    return handleApproveEmailSequence(req, res);
    case 'mark-sprint-purchased':     return handleMarkSprintPurchased(req, res);
    case 'schedule-debrief-emails':   return handleScheduleDebriefEmails(req, res);
    case 'approve-email-draft':        return handleApproveEmailDraft(req, res);
    case 'hold-email-draft':           return handleHoldEmailDraft(req, res);
    case 'send-email-draft-now':       return handleSendEmailDraftNow(req, res);
    case 'cancel-scheduled-email':    return handleCancelScheduledEmail(req, res);
    default:
      return res.status(400).json({ error: `Unknown action: "${action}". Valid: send-invites, schedule-invites, send-scheduled, trial-sweep, send-leader-link, generate-question, generate-g2-question, generate-report, generate-team-report, finalize-report, sign-report-upload, generate-dr-content, request-external-feedback, feedback-context, submit-external-feedback, reminders, generate-email-drafts, get-email-drafts, update-email-draft, approve-email-draft, hold-email-draft, send-email-draft-now, approve-email-sequence, mark-sprint-purchased, schedule-debrief-emails, cancel-scheduled-email` });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: resend-rater — re-send ONE rater's survey invite (e.g. they lost the link)
// POST /api/diagnostic?action=resend-rater   Body: { rater_id, session }
// Reuses the exact diagnostic_invite email (editable template + fallback).
// ═══════════════════════════════════════════════════════════════════════════════
async function handleResendRater(req, res) {
  const { rater_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!rater_id) return res.status(400).json({ error: 'rater_id required' });
  try {
    const rRes  = await sb(`/rest/v1/diagnostic_raters?id=eq.${rater_id}&select=id,name,email,relationship,token,will_interview,invited_at,diagnostic_id&limit=1`);
    const rRows = await rRes.json();
    const rater = Array.isArray(rRows) ? rRows[0] : null;
    if (!rater)       return res.status(404).json({ error: 'Rater not found' });
    if (!rater.email) return res.status(400).json({ error: 'This rater has no email on file.' });

    const dRes  = await sb(`/rest/v1/diagnostics?id=eq.${rater.diagnostic_id}&select=client_name,client_title,client_org,client_email,interviews_enabled,interview_calendar_link,anonymous_feedback&limit=1`);
    const dRows = await dRes.json();
    const diag  = Array.isArray(dRows) ? dRows[0] : null;
    if (!diag) return res.status(404).json({ error: 'Diagnostic not found' });

    const now = new Date();
    const closeDate = new Date(now); closeDate.setDate(closeDate.getDate() + 7);
    const closeDateDisp = closeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const surveyLink   = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;
    const calendarLink = (diag.interviews_enabled && rater.will_interview && diag.interview_calendar_link) ? diag.interview_calendar_link : null;

    let subject  = calendarLink
      ? `Your input is requested — ${diag.client_name} leadership feedback + interview invite`
      : `Your input is requested — ${diag.client_name} leadership feedback`;
    let bodyHtml = null;
    const inviteTpl = await getApprovedTemplate('diagnostic_invite');
    if (inviteTpl) {
      const vars = {
        first_name:  (rater.name || '').split(' ')[0] || 'there',
        rater_name:  rater.name || '',
        leader_name: diag.client_name || '',
        leader_full: [diag.client_name, diag.client_title, diag.client_org].filter(Boolean).join(' — '),
        close_date:  closeDateDisp,
        survey_link: surveyLink,
      };
      if (inviteTpl.subject)   subject  = fillTemplate(inviteTpl.subject, vars) || subject;
      if (inviteTpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(inviteTpl.body_text, vars));
    }
    const html = buildInviteEmail({
      raterName: rater.name, leaderName: diag.client_name, leaderTitle: diag.client_title,
      leaderOrg: diag.client_org, surveyLink, closeDate: closeDateDisp, calendarLink, bodyHtml,
    });
    const cc = buildDiagCc(await loadCcConfig(), diag, 'invite');
    await sendEmail({ to: rater.email, subject, html, emailType: 'diagnostic_invite', recipientName: rater.name, cc });
    if (!rater.invited_at) {
      await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { invited_at: now.toISOString() }, { Prefer: 'return=minimal' });
    }
    return res.status(200).json({ ok: true, sent_to: rater.email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send-invites
// POST /api/diagnostic?action=send-invites
// Body: { diagnostic_id }
// ═══════════════════════════════════════════════════════════════════════════════

function buildInviteEmail({ raterName, leaderName, leaderTitle, leaderOrg, surveyLink, closeDate, calendarLink, bodyHtml }) {
  const firstName  = (raterName || '').split(' ')[0] || 'there';
  const leaderFull = [leaderName, leaderTitle, leaderOrg].filter(Boolean).join(' — ');
  // closeDate is already a formatted string (e.g. "June 12, 2026") — use directly
  const closeFmt = closeDate || 'the survey deadline';

  // Editable copy region — from the approved template when present, else the
  // built-in default. The survey button + interview section below stay structural.
  const defaultBody = `<p>Hi ${firstName},</p>
        <p>I'm asking for your honest feedback as part of a leadership development process for:</p>
        <div style="background:#f5f7fa;border-left:4px solid #1A3D6E;padding:14px 18px;border-radius:0 6px 6px 0;margin:16px 0;">
          <strong>${leaderFull}</strong>
        </div>
        <p>The survey takes approximately 15–20 minutes to complete. Your responses help build a clear, honest picture of leadership strengths and development areas.</p>
        <p><strong>A few things to know:</strong></p>
        <ul style="margin:0 0 16px 0;padding-left:20px;">
          <li>Your responses are kept confidential — individual answers are never shared with the leader.</li>
          <li>Please complete it by <strong>${closeFmt}</strong>.</li>
          <li>Honest, specific feedback is the most useful. Don't overthink it.</li>
        </ul>`;
  const bodyContent = bodyHtml || defaultBody;

  // Optional interview booking section (appended when calendarLink is provided)
  const interviewSection = calendarLink ? `
    <div style="margin:28px 0;background:#f0f4ff;border:1.5px solid #1A3D6E;border-radius:8px;padding:20px 24px;">
      <div style="font-size:14px;font-weight:700;color:#1A3D6E;margin-bottom:8px;">📅 Also: Schedule a Brief Interview</div>
      <p style="margin:0 0 14px;font-size:14px;color:#333;">
        In addition to the survey, I'd like to schedule a short conversation with you — typically 20–30 minutes.
        Use the link below to pick a time that works for you.
      </p>
      <div style="text-align:center;">
        <a href="${calendarLink}"
           style="background:#C09A2A;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
          Book Your Interview Time →
        </a>
      </div>
      <p style="font-size:12px;color:#666;margin-top:12px;text-align:center;">
        Or copy: <a href="${calendarLink}" style="color:#1A3D6E;">${calendarLink}</a>
      </p>
    </div>` : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Leadership Feedback Request</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        ${bodyContent}
        <div style="margin:28px 0;text-align:center;">
          <a href="${surveyLink}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Complete the Survey →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${surveyLink}" style="color:#1A3D6E;">${surveyLink}</a></p>
        ${interviewSection}
        <p style="margin-top:24px;">Thank you for taking the time — this feedback genuinely matters.</p>
        <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
          You're receiving this because you were nominated as a feedback provider for a GPS Leadership diagnostic.
          If you believe this was sent in error, please reply to this email.
        </div>
      </div>
    </div>
  `;
}

// Reusable send core — shared by the manual send-invites action and the
// scheduled (cron) send. Returns { httpStatus, payload } so callers can map to
// HTTP or inspect the result. Idempotent at the rater level: only raters with
// invited_at IS NULL are emailed, so a retry never double-sends. Sets
// invites_sent_at (and clears any pending schedule) only when at least one email
// actually went out.
async function sendInvitesForDiagnostic(diagnostic_id) {
  const diagRes = await sb(
    `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,client_email,close_date,status,self_assessment_completed_at,interviews_enabled,interview_calendar_link,anonymous_feedback&limit=1`
  );
  const diags = await diagRes.json();
  if (!Array.isArray(diags) || diags.length === 0) return { httpStatus: 404, payload: { error: 'Diagnostic not found' } };
  const diag = diags[0];

  if (!diag.self_assessment_completed_at) {
    return { httpStatus: 400, payload: { error: 'Self-assessment not complete. Leader must finish the self-assessment before invites can be sent.' } };
  }

  const ratersRes = await sb(
    `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&is_self=eq.false&invited_at=is.null&select=id,name,email,relationship,token,will_interview`
  );
  const raters = await ratersRes.json();

  if (!Array.isArray(raters) || raters.length === 0) {
    return { httpStatus: 200, payload: { message: 'No uninvited raters found — all raters may already have been invited.', sent: 0, skipped: 0, errors: [] } };
  }

  let sent = 0;
  const errors = [];
  const sentList = [];
  const now = new Date();
  const nowISO = now.toISOString();

  // Close date = exactly 7 days from invite send (overrides any manual close_date).
  // A survey should never close on a weekend — roll Sat/Sun forward to Monday so the
  // 3-day-out reminder lands on the Friday before, not on a Saturday nobody reads.
  const closeDate = new Date(now);
  closeDate.setDate(closeDate.getDate() + 7);
  const closeDateISO  = rollCloseOffWeekend(closeDate.toISOString().split('T')[0]); // YYYY-MM-DD, never a weekend
  const closeDateDisp = new Date(closeDateISO + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  // Editable invite template (Communication → Email Templates); loaded once, filled per rater.
  const inviteTpl = await getApprovedTemplate('diagnostic_invite');

  for (const rater of raters) {
    const surveyLink = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;
    // Include calendar link in email only when this rater is marked for interview AND a link exists
    const calendarLink = (diag.interviews_enabled && rater.will_interview && diag.interview_calendar_link)
      ? diag.interview_calendar_link
      : null;
    let subject    = calendarLink
      ? `Your input is requested — ${diag.client_name} leadership feedback + interview invite`
      : `Your input is requested — ${diag.client_name} leadership feedback`;
    let bodyHtml = null;
    if (inviteTpl) {
      const vars = {
        first_name:  (rater.name || '').split(' ')[0] || 'there',
        rater_name:  rater.name || '',
        leader_name: diag.client_name || '',
        leader_full: [diag.client_name, diag.client_title, diag.client_org].filter(Boolean).join(' — '),
        close_date:  closeDateDisp,
        survey_link: surveyLink,
      };
      if (inviteTpl.subject)   subject  = fillTemplate(inviteTpl.subject, vars) || subject;
      if (inviteTpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(inviteTpl.body_text, vars));
    }
    const html       = buildInviteEmail({
      raterName:   rater.name,
      leaderName:  diag.client_name,
      leaderTitle: diag.client_title,
      leaderOrg:   diag.client_org,
      surveyLink,
      closeDate:   closeDateDisp,
      calendarLink,
      bodyHtml,
    });

    // The leader IS copied on the invite (stage 'invite') — deliberately, for credibility:
    // raters see their leader is genuinely behind this. The invite predates any responses,
    // so it exposes no completion data, and individual ratings remain anonymous regardless.
    // Reminders (which target only non-completers) never copy the leader — see buildDiagCc.
    const inviteCc = buildDiagCc(await loadCcConfig(), diag, 'invite');
    try {
      await sendEmail({ to: rater.email, subject, html, emailType: 'diagnostic_invite', recipientName: rater.name, cc: inviteCc });
      await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { invited_at: nowISO }, { Prefer: 'return=minimal' });
      sent++;
      sentList.push({ name: rater.name, email: rater.email, interview: !!calendarLink });
    } catch (err) {
      errors.push({ name: rater.name, email: rater.email, error: err.message });
    }
  }

  if (sent > 0) {
    const updates = {
      invites_sent_at: nowISO,
      start_date:  nowISO.split('T')[0],   // survey opens today
      close_date:  closeDateISO,            // closes 7 days from today
      updated_at:  nowISO,
      invites_scheduled_at: null,           // consume any pending schedule
      invites_schedule_claimed_at: null,
    };
    if (diag.status !== 'survey_open') updates.status = 'survey_open';
    await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH', updates, { Prefer: 'return=minimal' });
  }

  return { httpStatus: 200, payload: { message: `Invites sent: ${sent} of ${raters.length}`, sent, sentList, errors } };
}

async function handleSendInvites(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' }); // P0-4 2026-07-01

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(diagnostic_id)) return res.status(400).json({ error: 'Invalid diagnostic_id' }); // P0-4

  try {
    const r = await sendInvitesForDiagnostic(diagnostic_id);
    return res.status(r.httpStatus).json(r.payload);
  } catch (err) {
    console.error('[diagnostic/send-invites] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: schedule-invites  (coach session auth)
// POST /api/diagnostic?action=schedule-invites
// Body: { diagnostic_id, scheduled_at (ISO string | null to cancel), session }
// ═══════════════════════════════════════════════════════════════════════════════
async function handleScheduleInvites(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, scheduled_at, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,self_assessment_completed_at,invites_sent_at&limit=1`);
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];
    if (diag.invites_sent_at) return res.status(400).json({ error: 'Invites have already been sent for this diagnostic.' });

    const nowISO = new Date().toISOString();

    if (scheduled_at) {
      if (!diag.self_assessment_completed_at) {
        return res.status(400).json({ error: 'Self-assessment not complete. The leader must finish it before invites can be scheduled.' });
      }
      const when = new Date(scheduled_at);
      if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid date/time.' });
      if (when.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'That time is in the past. Pick a future date/time.' });
      await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH',
        { invites_scheduled_at: when.toISOString(), invites_schedule_claimed_at: null, updated_at: nowISO },
        { Prefer: 'return=minimal' });
      return res.status(200).json({ ok: true, scheduled_at: when.toISOString() });
    }

    // No scheduled_at => cancel any existing schedule.
    await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH',
      { invites_scheduled_at: null, invites_schedule_claimed_at: null, updated_at: nowISO },
      { Prefer: 'return=minimal' });
    return res.status(200).json({ ok: true, scheduled_at: null });
  } catch (err) {
    console.error('[diagnostic/schedule-invites] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send-scheduled  (cron auth: x-vercel-cron / CRON_SECRET / coach session)
// GET|POST /api/diagnostic?action=send-scheduled
// Finds diagnostics whose scheduled time has passed and sends their invites once.
// Claim column prevents overlapping runs from double-processing; the per-rater
// invited_at guard prevents double emails even if a claim is released for retry.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSendScheduled(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron    = req.headers['x-vercel-cron'] === '1';
  const isManualTrigger = req.method === 'POST' && !!verifyCoachSession(req.body?.session);
  const authHeader      = req.headers['authorization'] || '';
  const hasSecret       = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualTrigger && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowISO = new Date().toISOString();
  const log = { processed: [], skipped: [], errors: [], auto_closed: [] };

  // ── Auto-close: any survey_open diagnostic whose close_date has passed flips to
  // survey_closed (stamps survey_closed_at). This is what the leader page already
  // promises ("follows automatically when the survey window ends") — previously it
  // never happened, so surveys sat open past their date. Runs every 15 min via this
  // cron. The status=eq.survey_open guard on the PATCH makes it safe + idempotent.
  try {
    const todayStr = nowISO.split('T')[0];
    const ocRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&close_date=lt.${todayStr}&select=id,client_name`);
    const overdue = ocRes.ok ? (await ocRes.json() || []) : [];
    for (const od of overdue) {
      const r = await sb(`/rest/v1/diagnostics?id=eq.${od.id}&status=eq.survey_open`, 'PATCH',
        { status: 'survey_closed', survey_closed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { Prefer: 'return=minimal' });
      if (r.ok) log.auto_closed.push({ id: od.id, client: od.client_name });
    }
  } catch (e) { log.errors.push({ stage: 'auto-close', error: e.message }); }

  // ── Scheduled consolidated peer-feedback nudges ──────────────────────────────
  // A server-side schedule: fire a consolidated nudge for an org at a set time,
  // independent of any coach being logged in. Atomic claim (claimed_at flips from
  // null) guarantees exactly one run sends it, even with overlapping cron ticks.
  try {
    const nudgeRes = await sb(
      `/rest/v1/scheduled_nudges?scheduled_for=lte.${nowISO}&sent_at=is.null&claimed_at=is.null&select=id,client_org,kind&order=scheduled_for.asc&limit=20`
    );
    const dueNudges = nudgeRes.ok ? (await nudgeRes.json() || []) : [];
    for (const n of dueNudges) {
      const claim = await sb(
        `/rest/v1/scheduled_nudges?id=eq.${n.id}&claimed_at=is.null`, 'PATCH',
        { claimed_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      const claimed = claim.ok ? await claim.json() : [];
      if (!Array.isArray(claimed) || claimed.length === 0) { log.skipped.push({ nudge: n.id, reason: 'already claimed' }); continue; }
      try {
        const out = await sendConsolidatedNudge(n.client_org, { dryRun: false });
        await sb(`/rest/v1/scheduled_nudges?id=eq.${n.id}`, 'PATCH',
          { sent_at: new Date().toISOString(), result: out }, { Prefer: 'return=minimal' });
        log.processed.push({ scheduled_nudge: n.id, org: n.client_org, sent: out.sent, skipped: out.skipped });
      } catch (e) {
        await sb(`/rest/v1/scheduled_nudges?id=eq.${n.id}`, 'PATCH',
          { result: { error: e.message } }, { Prefer: 'return=minimal' });
        log.errors.push({ stage: 'scheduled-nudge', nudge: n.id, error: e.message });
      }
    }
  } catch (e) { log.errors.push({ stage: 'scheduled-nudges', error: e.message }); }

  try {
    const dueRes = await sb(
      `/rest/v1/diagnostics?invites_scheduled_at=lte.${nowISO}&invites_sent_at=is.null&invites_schedule_claimed_at=is.null&select=id,client_name&order=invites_scheduled_at.asc&limit=50`
    );
    const due = await dueRes.json() || [];

    for (const d of due) {
      // Atomic claim — only the run that flips claimed_at from null wins.
      const claimRes = await sb(
        `/rest/v1/diagnostics?id=eq.${d.id}&invites_schedule_claimed_at=is.null`, 'PATCH',
        { invites_schedule_claimed_at: new Date().toISOString() },
        { Prefer: 'return=representation' }
      );
      const claimed = await claimRes.json();
      if (!Array.isArray(claimed) || claimed.length === 0) { log.skipped.push({ id: d.id, reason: 'already claimed' }); continue; }

      try {
        const r = await sendInvitesForDiagnostic(d.id);
        if (r.httpStatus === 200 && (r.payload.sent || 0) > 0) {
          // Success: the core already set invites_sent_at and cleared the schedule + claim.
          log.processed.push({ id: d.id, client: d.client_name, sent: r.payload.sent });
        } else {
          // Nothing sent (no uninvited raters, or a precondition failed). Release the
          // claim so a corrected reschedule can run again; leave the schedule in place.
          await sb(`/rest/v1/diagnostics?id=eq.${d.id}`, 'PATCH', { invites_schedule_claimed_at: null }, { Prefer: 'return=minimal' });
          log.skipped.push({ id: d.id, reason: r.payload.error || r.payload.message || 'nothing to send' });
        }
      } catch (err) {
        // Send threw: release the claim so the next run retries (per-rater invited_at
        // guard means already-invited raters are never re-emailed).
        await sb(`/rest/v1/diagnostics?id=eq.${d.id}`, 'PATCH', { invites_schedule_claimed_at: null }, { Prefer: 'return=minimal' });
        log.errors.push({ id: d.id, error: err.message });
      }
    }

    // ── Send any due email_drafts (status=scheduled, scheduled_for<=now) ─────
    // This runs every 15 min so emails send close to their scheduled_for time.
    // send-reminders.js is the Monday backup; both are safe to run concurrently
    // because sendEmailDraft immediately PATCHes to 'sent', preventing re-send.
    const dueEmailsRes = await sb(
      '/rest/v1/email_drafts?status=eq.scheduled&scheduled_for=lte.' + encodeURIComponent(new Date().toISOString()) + '&select=id,email_key,subject,body,to_name,to_email&limit=50'
    );
    const dueDraftEmails = dueEmailsRes.ok ? await dueEmailsRes.json() : [];
    for (const draft of (Array.isArray(dueDraftEmails) ? dueDraftEmails : [])) {
      try {
        await sendEmailDraft(draft);
        log.processed.push({ id: draft.id, email_key: draft.email_key, to: draft.to_email });
      } catch (draftErr) {
        log.errors.push({ id: draft.id, email_key: draft.email_key, error: draftErr.message });
      }
    }

    await recordHeartbeat('diag-send-scheduled', log.errors.length ? 'error' : 'ok', `processed ${log.processed.length}, errors ${log.errors.length}`);
    return res.status(200).json({ ok: true, due: due.length, ...log });
  } catch (err) {
    console.error('[diagnostic/send-scheduled] error:', err);
    await recordHeartbeat('diag-send-scheduled', 'error', String(err.message || err).slice(0, 200));
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: trial-sweep  (cron auth: x-vercel-cron / CRON_SECRET / coach session)
// GET|POST /api/diagnostic?action=trial-sweep
// Identifies dormant workshop-guest (trial) accounts and, when armed/committed,
// archives the ones past the 10-day window. SAFETY: report-only by default.
// Live archiving happens ONLY when body.commit === true (a supervised manual run)
// or, for the cron, when env TRIAL_SWEEP_ARMED === 'true'. The archive write is
// double-guarded with the cohort filters so a real client can never be touched.
// Cohort = is_workshop_participant AND in_coaching_program=false AND NOT archived
// AND account_type='trial' AND NOT linked to any diagnostics row AND NOT activated
// (activated = plan_submitted_at set AND >=1 check-in). Nudge emails are deferred.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleTrialSweep(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron    = req.headers['x-vercel-cron'] === '1';
  const isManualTrigger = req.method === 'POST' && !!verifyCoachSession(req.body?.session);
  const authHeader      = req.headers['authorization'] || '';
  const hasSecret       = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualTrigger && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const commit  = req.body?.commit === true;
  const armed   = process.env.TRIAL_SWEEP_ARMED === 'true';
  const doArchive = commit || (isVercelCron && armed);

  const ARCHIVE_DAY = 10;
  const NUDGE_2_DAY = 8;
  const NUDGE_1_DAY = 3;
  const now = Date.now();

  try {
    // Cohort: trial workshop guests, not in coaching, not already archived.
    const cohortRes = await sb(`/rest/v1/clients?is_workshop_participant=eq.true&in_coaching_program=eq.false&is_archived=eq.false&account_type=eq.trial&select=id,name,email,invited_at,created_at,plan_submitted_at,welcome_sent_at&limit=2000`);
    const cohort = await cohortRes.json() || [];

    // Exclude any client linked to a diagnostics row (these are real clients).
    const diagRes = await sb(`/rest/v1/diagnostics?client_id=not.is.null&select=client_id&limit=5000`);
    const diagRows = await diagRes.json() || [];
    const diagClientIds = new Set((Array.isArray(diagRows) ? diagRows : []).map(d => d.client_id));

    // Activation requires >=1 check-in; fetch all check-in client_ids once.
    const ckRes = await sb(`/rest/v1/checkins?select=client_id&limit=20000`);
    const ckRows = await ckRes.json() || [];
    const checkinClientIds = new Set((Array.isArray(ckRows) ? ckRows : []).map(c => c.client_id));

    const buckets = { nudge_1: [], nudge_2: [], archive: [], activated: 0, diagnostic_excluded: 0, not_yet_welcomed: 0 };
    for (const c of cohort) {
      if (diagClientIds.has(c.id)) { buckets.diagnostic_excluded++; continue; } // never touch a diagnostic client
      const activated = !!c.plan_submitted_at && checkinClientIds.has(c.id);
      if (activated) { buckets.activated++; continue; }
      // The 10-day access clock starts when the WELCOME email is sent (= when they actually
      // get access), NOT at roster import. A roster can be imported days before the workshop.
      // No welcome sent yet → no access yet → clock hasn't started; leave them alone.
      const base = c.welcome_sent_at;
      if (!base) { buckets.not_yet_welcomed++; continue; }
      const days = Math.floor((now - new Date(base).getTime()) / 86400000);
      const item = { id: c.id, name: c.name, email: c.email, days };
      if (days >= ARCHIVE_DAY) buckets.archive.push(item);
      else if (days >= NUDGE_2_DAY) buckets.nudge_2.push(item);
      else if (days >= NUDGE_1_DAY) buckets.nudge_1.push(item);
    }

    let archived = 0;
    if (doArchive && buckets.archive.length) {
      const idList = buckets.archive.map(x => encodeURIComponent(x.id)).join(',');
      // Double-guard: re-assert the cohort filters in the WHERE so the write can
      // only ever land on trial / workshop-guest / not-in-coaching rows.
      await sb(
        `/rest/v1/clients?id=in.(${idList})&is_workshop_participant=eq.true&in_coaching_program=eq.false&account_type=eq.trial&is_archived=eq.false`,
        'PATCH', { is_archived: true }, { Prefer: 'return=minimal' }
      );
      archived = buckets.archive.length;
    }

    await recordHeartbeat('trial-sweep', 'ok', doArchive ? 'archive' : 'report');
    return res.status(200).json({
      ok: true,
      mode: doArchive ? 'archive' : 'report',
      armed, commit,
      cohort_size: cohort.length,
      counts: {
        would_nudge_day3: buckets.nudge_1.length,
        would_nudge_day8: buckets.nudge_2.length,
        would_archive: buckets.archive.length,
        activated: buckets.activated,
        diagnostic_excluded: buckets.diagnostic_excluded,
        not_yet_welcomed: buckets.not_yet_welcomed,
      },
      would_archive: buckets.archive,
      archived,
    });
  } catch (err) {
    console.error('[diagnostic/trial-sweep] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send-leader-link
// POST /api/diagnostic?action=send-leader-link
// Body: { diagnostic_id }
// Emails the leader their self-assessment portal link.
// Safe to re-send if the leader hasn't completed it yet.
// ═══════════════════════════════════════════════════════════════════════════════

function buildLeaderOnboardingEmail({ leaderName, leaderTitle, leaderOrg, portalLink, coachEmail }) {
  const firstName   = (leaderName || '').split(' ')[0] || 'there';
  const orgLine     = leaderOrg ? ` at ${leaderOrg}` : '';
  const contactLine = coachEmail
    ? `If you have questions, reply to this email or reach Alex directly at <a href="mailto:${coachEmail}" style="color:#1A3D6E;">${coachEmail}</a>.`
    : 'If you have questions, reply to this email.';

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Leadership Diagnostic Has Started</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        <p>Hi ${firstName},</p>
        <p>We're ready to begin your GPS Leadership Diagnostic. The first step is your self-assessment — a structured look at how you see your own leadership right now.</p>
        <p>This is where you set the baseline. Your raters' feedback will be compared against your own perspective, so be honest. There are no wrong answers.</p>
        <div style="background:#f5f7fa;border-left:4px solid #C09A2A;padding:16px 20px;border-radius:0 6px 6px 0;margin:20px 0;">
          <div style="font-weight:700;color:#1A3D6E;margin-bottom:6px;">What to expect:</div>
          <ul style="margin:0;padding-left:18px;font-size:14px;color:#333;">
            <li>The self-assessment takes approximately <strong>20–30 minutes</strong>.</li>
            <li>You'll answer questions about your leadership habits, team dynamics, and future vision.</li>
            <li>Your responses are visible only to Alex — not shared directly with your team.</li>
            <li>Complete it in one sitting if you can. You can save progress and return if needed.</li>
          </ul>
        </div>
        <div style="margin:28px 0;text-align:center;">
          <a href="${portalLink}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Open Your Leadership Portal →
          </a>
        </div>
        <p style="font-size:13px;color:#666;text-align:center;">Or copy this link: <a href="${portalLink}" style="color:#1A3D6E;word-break:break-all;">${portalLink}</a></p>
        <div style="background:#fbf7ec;border:1px solid #e8dcb8;border-radius:8px;padding:14px 18px;margin:18px 0;font-size:13px;color:#5a4a1f;line-height:1.6;">
          <strong>If the link won't open:</strong> some organizations' security tools block or rewrite outside links. If that happens, forward this note to your IT team:<br /><br />
          <em>"Please allowlist the website portal.gpsleadership.org (and gpsleadership.org) and emails from gpsleadership.org, and exclude them from link rewriting/sandboxing. It is a standard, confidential assessment site with no downloads or attachments."</em>
        </div>
        <p style="margin-top:24px;">Once you complete the self-assessment, I'll reach out about next steps — including finalizing the list of people who will provide feedback on your leadership. When that time comes, adding them is easy: type them in one at a time, upload a spreadsheet (we provide a template), or just send us the list and our team will upload it for you.</p>
        <p>${contactLine}</p>
        <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
          This link is unique to you and should not be shared. If you believe you received this in error, please reply to this email.
        </div>
      </div>
    </div>
  `;
}

async function handleSendLeaderLink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,client_email,leader_token,self_assessment_completed_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    if (!diag.client_email) return res.status(400).json({ error: 'No email address on file for this leader. Add it in the diagnostic setup before sending.' });
    if (!diag.leader_token) return res.status(400).json({ error: 'Leader token not found. This diagnostic may be incomplete — please contact support.' });

    if (diag.self_assessment_completed_at) {
      return res.status(400).json({ error: 'Self-assessment already completed. No need to re-send the portal link.' });
    }

    const portalLink = `${PORTAL_BASE}/diagnostic-leader.html?token=${diag.leader_token}`;
    const subject    = `Your GPS Leadership Diagnostic is ready — next steps inside`;
    const html       = buildLeaderOnboardingEmail({
      leaderName:  diag.client_name,
      leaderTitle: diag.client_title,
      leaderOrg:   diag.client_org,
      portalLink,
      coachEmail:  COACH_EMAIL,
    });

    await sendEmail({
      to:            diag.client_email,
      subject,
      html,
      emailType:     'leader_onboarding',
      recipientName: diag.client_name,
    });

    return res.status(200).json({ message: `Portal link sent to ${diag.client_email}`, email: diag.client_email });

  } catch (err) {
    console.error('[diagnostic/send-leader-link] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-question
// POST /api/diagnostic?action=generate-question
// Body: { diagnostic_id }
// ═══════════════════════════════════════════════════════════════════════════════

const G1_SYSTEM_PROMPT = `You are an executive leadership assessment specialist working for GPS Leadership Solutions.

Your job is to write a single, high-quality behavioral feedback question for a leadership diagnostic survey. This question (called G1) will be answered by the leader's raters on a 1–5 scale (1 = Strongly Disagree, 5 = Strongly Agree).

The question must:
1. Be specific to the leader's stated 3-year vision and future direction — not generic
2. Start with the leader's first name as provided in the input — no placeholders, no brackets
3. Evaluate whether current behaviors align with where the leader says they want to go
4. Be answerable from observable behavior, not speculation about intentions
5. Be one sentence, direct, and unambiguous — raters should know exactly what to evaluate
6. Be at the same difficulty level as the other survey questions (not a softball, not a trick)

CRITICAL RULES:
- Use the leader's first name at the start of the question. Example: "Alex consistently..." or "Vanessa demonstrates..."
- NEVER use gendered pronouns (he/she/his/her/him). If you must refer to the leader again in the sentence, use their first name or "this leader" — never "she" or "her" or "he" or "him".
- Do NOT use brackets, placeholders, or template variables of any kind.

Format: Return ONLY the question text. No preamble, no explanation, no quotation marks.

Example output (do not copy this — write something specific to the input):
Alex demonstrates the leadership behaviors required to transition the business from an operator-led model to a team-led model.`;

async function handleGenerateQuestion(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' }); // P0-4 2026-07-01
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(diagnostic_id)) return res.status(400).json({ error: 'Invalid diagnostic_id' }); // P0-4

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,self_three_year_vision,self_future_self_capabilities,self_assessment_completed_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    if (!diag.self_three_year_vision) {
      return res.status(400).json({ error: 'Leader has not completed the self-assessment. self_three_year_vision is required to generate G1.' });
    }

    // Server-side debounce: block requests within 30 seconds of last generation
    if (diag.custom_g1_generated_at) {
      const secondsSince = (Date.now() - new Date(diag.custom_g1_generated_at).getTime()) / 1000;
      if (secondsSince < 30) {
        return res.status(429).json({ error: `Please wait ${Math.ceil(30 - secondsSince)} seconds before regenerating.` });
      }
    }

    const leaderFirstName = (diag.client_name || '').split(' ')[0];
    const userPrompt = `Leader full name: ${diag.client_name}
Leader first name (use this to start the question): ${leaderFirstName}

3-Year Vision:
${diag.self_three_year_vision}

${diag.self_future_self_capabilities ? `Future self / capabilities they want to develop:\n${diag.self_future_self_capabilities}` : ''}

Write the G1 question for this leader. Start the sentence with "${leaderFirstName}" and do not use any gendered pronouns.`;

    const question = await callClaude(G1_SYSTEM_PROMPT, userPrompt, 512);
    if (!question) return res.status(500).json({ error: 'Claude returned an empty response' });

    const now = new Date().toISOString();
    await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}`,
      'PATCH',
      { custom_g1_question: question, custom_g1_generated_at: now, updated_at: now },
      { Prefer: 'return=minimal' }
    );

    return res.status(200).json({ question, generated_at: now });

  } catch (err) {
    console.error('[diagnostic/generate-question] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-g2-question
// POST /api/diagnostic?action=generate-g2-question
// Body: { diagnostic_id }
// Generates a second custom survey question (G2) drawn from the leader's full
// self-assessment. The question is designed to surface a behavioral pattern that
// a GPS leadership engagement directly addresses — without being obviously about
// coaching. Raters score it 1–5 without knowing its intent.
// ═══════════════════════════════════════════════════════════════════════════════

const G2_SYSTEM_PROMPT = `You are an executive leadership assessment specialist working for GPS Leadership Solutions.

GPS Leadership Solutions installs leadership operating systems for CEOs and senior leaders — the infrastructure of delegation, accountability, decision-making, and team autonomy that allows a business to grow without the leader being the bottleneck.

Your job is to write a second custom behavioral survey question (called G2) for a leadership diagnostic. This question will be answered by raters on a 1–5 scale (1 = Strongly Disagree, 5 = Strongly Agree).

The question should subtly surface one of the most common leadership gaps that GPS directly addresses:
- Leaders who make too many decisions themselves (not building decision infrastructure)
- Leaders whose teams can't operate without them (bottleneck leaders)
- Leaders who say they delegate but pull decisions back up
- Leaders who don't build accountability systems — relying on follow-up instead
- Leaders who aren't developing the next level to take ownership

Read the leader's self-assessment responses carefully. Identify ONE specific behavioral pattern revealed there — something the leader said or implied — that connects to one of the above gaps. Write the question to surface whether that specific gap exists, based on observable rater experience.

CRITICAL RULES:
- Use the leader's first name to start the question — no placeholders, no brackets
- NEVER use gendered pronouns (he/she/his/her/him). Use the leader's first name or "this leader" if needed again.
- The question must be behavioral and observable — raters can answer from direct experience
- Do NOT mention coaching, GPS Leadership, or consulting in any way
- Do NOT make the question obviously about "needing help" — make it about behavior
- One sentence, direct, specific. Not a softball.

Format: Return ONLY the question text. No preamble, no explanation, no quotation marks.

Example (do not copy — write something grounded in the actual input):
Marcus creates the conditions for the team to make decisions without escalating to Marcus first.`;

async function handleGenerateG2Question(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' }); // P0-4 2026-07-01
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(diagnostic_id)) return res.status(400).json({ error: 'Invalid diagnostic_id' }); // P0-4

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,self_three_year_vision,self_future_self_capabilities,self_immediate_successor_view,self_successor_candidates,self_successor_development_actions,self_assessment_completed_at,custom_g2_generated_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    if (!diag.self_assessment_completed_at) {
      return res.status(400).json({ error: 'Leader has not completed the self-assessment. G2 requires self-assessment data.' });
    }

    // Debounce: 30 seconds between regenerations
    if (diag.custom_g2_generated_at) {
      const secondsSince = (Date.now() - new Date(diag.custom_g2_generated_at).getTime()) / 1000;
      if (secondsSince < 30) {
        return res.status(429).json({ error: `Please wait ${Math.ceil(30 - secondsSince)} seconds before regenerating.` });
      }
    }

    const leaderFirstName = (diag.client_name || '').split(' ')[0];
    const selfData = [
      diag.self_three_year_vision          ? `3-Year Vision:\n${diag.self_three_year_vision}` : '',
      diag.self_future_self_capabilities   ? `Future capabilities / who they want to become:\n${diag.self_future_self_capabilities}` : '',
      diag.self_immediate_successor_view   ? `Immediate successor view:\n${diag.self_immediate_successor_view}` : '',
      diag.self_successor_candidates       ? `Successor candidates:\n${diag.self_successor_candidates}` : '',
      diag.self_successor_development_actions ? `Successor development actions:\n${diag.self_successor_development_actions}` : '',
    ].filter(Boolean).join('\n\n');

    const userPrompt = `Leader full name: ${diag.client_name}
Leader first name (use this to start the question): ${leaderFirstName}

Self-Assessment Responses:
${selfData || '(No self-assessment data available)'}

Write the G2 question for this leader. Start with "${leaderFirstName}" and do not use gendered pronouns.`;

    const question = await callClaude(G2_SYSTEM_PROMPT, userPrompt, 512);
    if (!question) return res.status(500).json({ error: 'Claude returned an empty response' });

    const now = new Date().toISOString();
    await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}`,
      'PATCH',
      { custom_g2_question: question, custom_g2_generated_at: now, updated_at: now },
      { Prefer: 'return=minimal' }
    );

    return res.status(200).json({ question, generated_at: now });

  } catch (err) {
    console.error('[diagnostic/generate-g2-question] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-report
// POST /api/diagnostic?action=generate-report
// Body: { diagnostic_id }
// ═══════════════════════════════════════════════════════════════════════════════

const QUESTIONS = {
  A1: 'Does what they say they will do.',
  A2: 'Is honest and transparent in their communication.',
  A3: "Follows through on commitments, even when it's difficult.",
  A4: 'Admits mistakes and takes responsibility for outcomes.',
  A5: 'Treats people consistently — no favorites, no shifting standards.',
  A6: 'Creates an environment where people can speak up without fear.',
  A7: 'Builds trust through actions, not just words.',
  B1: 'Anticipates problems before they become crises.',
  B2: 'Brings solutions, not just problems.',
  B3: 'Takes initiative without being told what to do.',
  B4: 'Prepares thoroughly before meetings, decisions, or client interactions.',
  B5: 'Identifies opportunities to improve before being prompted.',
  B6: 'Helps the team prepare and think ahead — not just react.',
  C1: 'Focuses time on high-value work, not just staying busy.',
  C2: 'Makes decisions efficiently without over-analyzing or delaying unnecessarily.',
  C3: 'Manages commitments well — meetings, deadlines, and deliverables.',
  C4: 'Helps others use their time effectively (tight meetings, clear direction).',
  C5: 'Eliminates or delegates low-value work rather than doing it themselves.',
  C6: 'Produces consistent, high-quality output without constant follow-up.',
  D1: 'Overall leadership impact on the organization.',
  F1: 'Actively develops the people around them to be stronger leaders.',
  F2: 'Is building a team that could operate effectively without them.',
};

const OPEN_ENDED = {
  A8:  'What is one specific behavior that demonstrates how this leader builds or erodes trust?',
  A9:  "When has this leader's honesty or transparency made a difference?",
  A10: "What one change in this leader's behavior would most increase trust?",
  B7:  'Describe a situation where this leader was proactive in a meaningful way.',
  B8:  "Where does this leader's lack of proactivity create problems for the team?",
  B9:  'What would being more proactive look like for this leader in their current role?',
  B10: 'What one thing could this leader start doing to be more proactive?',
  C7:  "How does this leader's use of time affect the people around them?",
  C8:  'What is one thing this leader does that wastes time — for themselves or the team?',
  C9:  'What would "more productive" look like for this leader in practice?',
  D2:  'What is the single most important change this leader could make to increase their impact?',
  F3:  'What is the biggest barrier to this leader building a stronger bench around them?',
};

function avg(scores) {
  const valid = scores.filter(s => s != null && !isNaN(s));
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
}

function label(score, scale = 5) {
  if (score == null) return 'Insufficient data';
  const pct = (score / scale) * 100;
  if (pct >= 80) return 'Strong';
  if (pct >= 65) return 'Solid';
  if (pct >= 50) return 'Developing';
  return 'Needs Attention';
}

function buildScoreSummary(responses, impactScale = 10) {
  const byCode = {};
  for (const r of responses) {
    if (r.score == null) continue;
    if (!byCode[r.question_code]) byCode[r.question_code] = [];
    byCode[r.question_code].push(Number(r.score));
  }

  const qAvg = (codes) => avg(codes.flatMap(c => byCode[c] || []));

  const trustScore        = qAvg(['A1','A2','A3','A4','A5','A6','A7']);
  const proactivityScore  = qAvg(['B1','B2','B3','B4','B5','B6']);
  const productivityScore = qAvg(['C1','C2','C3','C4','C5','C6']);
  const impactScore       = qAvg(['D1']);
  const benchScore        = qAvg(['F1','F2']);
  const g1Score           = qAvg(['G1']);
  const g2Score           = qAvg(['G2']);
  const tp3Index          = avg([trustScore, proactivityScore, productivityScore].filter(s => s != null));

  const perQuestion = {};
  for (const [code, scores] of Object.entries(byCode)) {
    perQuestion[code] = { avg: avg(scores), n: scores.length };
  }

  return {
    trustScore, proactivityScore, productivityScore,
    tp3Index, impactScore, benchScore, g1Score, g2Score, impactScale,
    perQuestion,
    raterCount: new Set(responses.map(r => r.rater_id)).size,
  };
}

function collectVerbatims(responses, maxPerCode = 4) {
  const verbatims = {};
  for (const r of responses) {
    if (!r.text_response?.trim()) continue;
    if (!verbatims[r.question_code]) verbatims[r.question_code] = [];
    // Cap verbatims per question code to limit prompt size and stay within function timeout
    if (verbatims[r.question_code].length < maxPerCode) {
      verbatims[r.question_code].push(r.text_response.trim());
    }
  }
  return verbatims;
}

function formatScoresForPrompt(scores) {
  const { perQuestion } = scores;
  const lines = [];
  const section = (codes, name) => {
    lines.push(`\n${name}:`);
    for (const c of codes) {
      const q = perQuestion[c];
      lines.push(q ? `  ${c}: ${q.avg?.toFixed(2) ?? 'n/a'}/5.0 (n=${q.n})` : `  ${c}: no data`);
    }
  };
  section(['A1','A2','A3','A4','A5','A6','A7'], 'Trust (A1-A7, scale 1-5)');
  lines.push(`  → Trust Score: ${scores.trustScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.trustScore)}`);
  section(['B1','B2','B3','B4','B5','B6'], 'Proactivity (B1-B6, scale 1-5)');
  lines.push(`  → Proactivity Score: ${scores.proactivityScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.proactivityScore)}`);
  section(['C1','C2','C3','C4','C5','C6'], 'Productivity (C1-C6, scale 1-5)');
  lines.push(`  → Productivity Score: ${scores.productivityScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.productivityScore)}`);
  const d1 = perQuestion['D1'];
  lines.push(`\nOverall Impact (D1, scale 1-${scores.impactScale}):\n  D1: ${d1?.avg?.toFixed(2) ?? 'n/a'}/${scores.impactScale}.0 (n=${d1?.n ?? 0})`);
  lines.push(`\nBench / Succession Readiness (F1-F2, scale 1-5):`);
  lines.push(`  F1: ${perQuestion['F1']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F1']?.avg)}`);
  lines.push(`  F2: ${perQuestion['F2']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F2']?.avg)}`);
  if (scores.g1Score != null) lines.push(`\nCustom Question G1 (vision alignment, scale 1-5): ${scores.g1Score?.toFixed(2) ?? 'n/a'}/5.0`);
  if (scores.g2Score != null) lines.push(`Custom Question G2 (GPS gap probe, scale 1-5): ${scores.g2Score?.toFixed(2) ?? 'n/a'}/5.0`);
  lines.push(`\nSummary:\n  TP3 Index: ${scores.tp3Index?.toFixed(2) ?? 'n/a'}/5.0\n  Overall Impact: ${scores.impactScore?.toFixed(2) ?? 'n/a'}/${scores.impactScale}.0\n  Total raters (others): ${scores.raterCount}`);
  return lines.join('\n');
}

function formatVerbatimsForPrompt(verbatims) {
  const sections = [
    { label: 'Trust open-ended (A8-A10)', codes: ['A8','A9','A10'] },
    { label: 'Proactivity open-ended (B7-B10)', codes: ['B7','B8','B9','B10'] },
    { label: 'Productivity open-ended (C7-C9)', codes: ['C7','C8','C9'] },
    { label: 'Overall impact comment (D2)', codes: ['D2'] },
    { label: 'Bench / succession comment (F3)', codes: ['F3'] },
    { label: 'Custom question written answers (G2-G3)', codes: ['G2','G3'] },
  ];
  const lines = [];
  for (const s of sections) {
    const quotes = s.codes.flatMap(c => (verbatims[c] || []).map(v => `  - ${v}`));
    if (quotes.length > 0) { lines.push(`\n${s.label}:`); lines.push(...quotes); }
  }
  return lines.length > 0 ? lines.join('\n') : '\n(No verbatim responses available)';
}

// ── Save per-diagnostic rater group labels + note (coach only) ───────────────
// Renames a rater group WITHOUT moving anyone between buckets. Use when the
// relationship a leader picked does not match the org chart — e.g. a CEO who
// entered her four chiefs as "Peer". Renaming keeps the group's numbers intact;
// merging it into another bucket would average its scores away.
async function handleSaveRaterGroupLabels(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' });

  const diagnostic_id = req.body?.diagnostic_id;
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  const ALLOWED = ['direct_report', 'peer', 'supervisor', 'internal_partner', 'board', 'other_colleagues'];
  const incoming = req.body?.labels;
  const labels = {};
  if (incoming && typeof incoming === 'object') {
    for (const k of ALLOWED) {
      const v = incoming[k];
      if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 60);
    }
  }
  const noteRaw = req.body?.note;
  const note = (typeof noteRaw === 'string' && noteRaw.trim()) ? noteRaw.trim().slice(0, 1000) : null;

  try {
    const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}`, 'PATCH',
      { rater_group_labels: labels, rater_group_note: note, updated_at: new Date().toISOString() },
      { Prefer: 'return=minimal' });
    if (!r.ok) throw new Error(`Save failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    return res.status(200).json({ ok: true, labels, note });
  } catch (err) {
    console.error('[diagnostic/save-rater-group-labels] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Per-rater-group data builder (Option B) ──────────────────────────────────
// labelOverrides (diagnostics.rater_group_labels) lets a group be RENAMED without
// moving anyone between buckets. The relationship a leader picks does not always
// match the org chart — on JMAA/Rosa the four chiefs (her actual executive team)
// were entered as "Peer". Merging them into Direct Reports would average their
// 3.48 trust into the other reports' 5.00 and destroy the central finding, so we
// keep the bucket intact and fix the name instead.
function buildRaterGroupData(responses, allRaters, labelOverrides) {
  const raterMetaMap = new Map(allRaters.map(r => [r.id, r]));

  // G2/G3 appear in BOTH lists: each custom question is either rated (score
  // rows) or open (text rows) per diagnostics.custom_gX_type — a response row
  // only ever carries one of the two, so dual membership is safe.
  const RATED  = ['A1','A2','A3','A4','A5','A6','A7','B1','B2','B3','B4','B5','B6','C1','C2','C3','C4','C5','C6','D1','F1','F2','G1','G2','G3'];
  const OPEN   = ['A8','A9','A10','B7','B8','B9','B10','C7','C8','C9','D2','F3','G2','G3'];
  const GKEYS  = ['direct_report','peer','supervisor','internal_partner','board'];

  // Normalize DB relationship values to GKEYS — DB may store title-case ("Peer", "Direct Report")
  // or legacy values ("Manager"). Match case-insensitively, then map to snake_case keys.
  const normalizeRel = (rel) => {
    if (!rel) return null;
    const n = rel.toLowerCase().replace(/[\s\-]+/g, '_');
    if (n === 'manager') return 'supervisor';     // legacy alias
    if (GKEYS.includes(n)) return n;
    // Current taxonomy (leader page, coach bulk import, Excel template):
    // map onto the report groups; everything else has no group bucket
    // (still counted in All Others via the fallback below).
    const s = n.replace(/[^a-z]/g, '');
    // Board FIRST — a board member is never a supervisor, even when their title
    // contains "owner"/"chair". Board is a confidential, aggregate-only group:
    // it is never attributed and, like every other group, never reported under
    // MIN_N. (Before this, "Board Member" fell through to null and was silently
    // blended into Other Colleagues — protected by accident, not by design.)
    if (s.includes('board') || s.includes('trustee')) return 'board';
    if (s.includes('skip') || s.includes('indirect')) return 'direct_report';
    if (s.includes('superv') || s.includes('manager') || s.includes('boss') || s.includes('owner')) return 'supervisor';
    if (s.includes('internal')) return 'internal_partner';
    return null;
  };

  const mkBucket = () => ({
    raterIds:  new Set(),
    scores:    Object.fromEntries(RATED.map(c => [c, []])),
    verbatims: Object.fromEntries(OPEN.map(c => [c, []])),
  });
  const buckets = {
    direct_report:    mkBucket(),
    peer:             mkBucket(),
    supervisor:       mkBucket(),
    internal_partner: mkBucket(),
    board:            mkBucket(),
    self:             mkBucket(),
    all_others:       mkBucket(),
    // Uncategorized non-self raters ("Other", "Driver", any unmapped label) — surfaced
    // as one "Other colleagues" row so no rater is silently dropped from the group table.
    other_colleagues: mkBucket(),
  };

  for (const resp of responses) {
    // Linked rows bucket via rater metadata; anonymous rows (rater_id NULL,
    // hard-cut anonymity) bucket via the relationship snapshot stored on the
    // response itself. Anonymous rows are never the self-assessment.
    let key, rowIsSelf;
    if (resp.rater_id != null) {
      const meta = raterMetaMap.get(resp.rater_id);
      if (!meta) continue;
      rowIsSelf = !!meta.is_self;
      key = rowIsSelf ? 'self' : normalizeRel(meta.relationship);
    } else {
      rowIsSelf = false;
      key = normalizeRel(resp.rater_relationship);
    }
    // Rows with no group bucket (Board Member, External Customer, free-text
    // Other, …) still count toward All Others — their feedback must not
    // silently vanish from the report.
    if (!key && rowIsSelf) continue;
    const ocl = (!key && !rowIsSelf);  // uncategorized colleague — no named group
    if (resp.rater_id != null) {
      if (key) buckets[key].raterIds.add(resp.rater_id);
      if (ocl) buckets.other_colleagues.raterIds.add(resp.rater_id);
      if (!rowIsSelf) buckets.all_others.raterIds.add(resp.rater_id);
    }
    if (resp.score != null && RATED.includes(resp.question_code)) {
      if (key) buckets[key].scores[resp.question_code].push(Number(resp.score));
      if (ocl) buckets.other_colleagues.scores[resp.question_code].push(Number(resp.score));
      if (!rowIsSelf) buckets.all_others.scores[resp.question_code].push(Number(resp.score));
    }
    if (resp.text_response?.trim() && OPEN.includes(resp.question_code)) {
      if (key) buckets[key].verbatims[resp.question_code].push(resp.text_response.trim());
      if (ocl) buckets.other_colleagues.verbatims[resp.question_code].push(resp.text_response.trim());
      if (!rowIsSelf) buckets.all_others.verbatims[resp.question_code].push(resp.text_response.trim());
    }
  }

  // Rater counts (n) come from the completed-raters list, not from response
  // rows — anonymous rows carry no rater identity to count distinctly.
  const completedCounts = { direct_report: 0, peer: 0, supervisor: 0, internal_partner: 0, board: 0, self: 0, all_others: 0, other_colleagues: 0 };
  for (const r of allRaters) {
    const k = r.is_self ? 'self' : normalizeRel(r.relationship);
    if (k) completedCounts[k]++;
    else if (!r.is_self) completedCounts.other_colleagues++;  // uncategorized colleague
    if (!r.is_self) completedCounts.all_others++;  // every non-self rater counts here, bucketed or not
  }

  const DEFAULT_LABELS = {
    direct_report: 'Direct Reports', peer: 'Peers', supervisor: 'Supervisors',
    internal_partner: 'Internal Partners', board: 'Board Members',
    self: 'Self', all_others: 'All Others', other_colleagues: 'Other Colleagues',
  };
  const ov = (labelOverrides && typeof labelOverrides === 'object') ? labelOverrides : {};
  const GROUP_LABELS = {};
  for (const k of Object.keys(DEFAULT_LABELS)) {
    const custom = typeof ov[k] === 'string' ? ov[k].trim() : '';
    GROUP_LABELS[k] = custom || DEFAULT_LABELS[k];
  }

  const result = {};
  for (const [key, b] of Object.entries(buckets)) {
    const avgScores = {};
    for (const c of RATED) avgScores[c] = avg(b.scores[c]);
    const tAvg  = avg(['A1','A2','A3','A4','A5','A6','A7'].map(c => avgScores[c]).filter(s => s != null));
    const prAvg = avg(['B1','B2','B3','B4','B5','B6'].map(c => avgScores[c]).filter(s => s != null));
    const pdAvg = avg(['C1','C2','C3','C4','C5','C6'].map(c => avgScores[c]).filter(s => s != null));
    result[key] = {
      label:           GROUP_LABELS[key],
      defaultLabel:    DEFAULT_LABELS[key],
      renamed:         GROUP_LABELS[key] !== DEFAULT_LABELS[key],
      n:               Math.max(b.raterIds.size, completedCounts[key] || 0),
      avgScores,
      verbatims:       b.verbatims,
      trustAvg:        tAvg,
      proactivityAvg:  prAvg,
      productivityAvg: pdAvg,
      tp3Index:        avg([tAvg, prAvg, pdAvg].filter(s => s != null)),
      impactAvg:       avgScores['D1'],
      benchAvg:        avg(['F1','F2'].map(c => avgScores[c]).filter(s => s != null)),
      g1Avg:           avgScores['G1'],
      g2Avg:           avgScores['G2'],
      suppressed:      false,
      suppressReason:  null,
    };
  }

  applyMinNSuppression(result);
  return result;
}

// ── Confidentiality: minimum-n suppression ──────────────────────────────────
// THE STANDARD (see Knowledge/GPS-Frameworks/Rater Confidentiality Standard):
//
//   1. A group is only reportable when at least MIN_N of its raters responded.
//      Below that it gets NO row, NO label, NO n, NO scores, NO verbatims.
//      Its scores still flow into the All Others average — nothing is deleted,
//      it just stops being separately countable.
//
//      This is not only a confidentiality rule. "Peers rated you 4.2," drawn
//      from one of three peers, is a FALSE STATEMENT about that group. One
//      person is not a group's view. The floor protects the validity of the
//      finding as much as it protects the rater.
//
//   2. SUPERVISOR IS EXEMPT. The supervisor is the one rater type we do not
//      promise confidentiality to — their view is meant to be attributable and
//      carries decision weight. They report at any n, including n=1. The
//      supervisor consent screen says so explicitly before they answer.
//
//   3. COMPLEMENTARY SUPPRESSION. Suppressing a group is not enough on its own.
//      If every displayed group average is shown next to the overall average,
//      the average of whatever is LEFT can be recovered by subtraction. If that
//      residual is 1 or 2 people, we just leaked them with arithmetic. So we
//      keep suppressing the smallest displayed group until the residual is
//      either 0 (nothing is hidden) or >= MIN_N (safely anonymous).
//
const MIN_N = 3;

function applyMinNSuppression(result) {
  // Groups that can be withheld. Supervisor is exempt by design; self is the
  // leader's own data; all_others is the pool that absorbs everyone.
  const NAMED = ['direct_report', 'peer', 'internal_partner', 'board', 'other_colleagues'];
  const POOL  = 'all_others';

  const withheld = [];
  const orphanedText = new Set();   // verbatims belonging to suppressed groups

  const suppress = (key, reason) => {
    const g = result[key];
    if (!g || g.suppressed) return;
    // Remember this group's verbatims before we drop them. The All Others bucket
    // also accumulated a copy of every one of them, and a verbatim carries its
    // author's vantage point in the WORDS — re-labelling it "All Others" launders
    // nothing. Nothing renders all_others verbatims today, but one future line of
    // code would resurrect the leak. Scrub them from the pool as well.
    for (const arr of Object.values(g.verbatims || {})) {
      for (const t of arr) if (t) orphanedText.add(t);
    }
    g.suppressed     = true;
    g.suppressReason = reason;
    g.avgScores      = {};   // no scores
    g.verbatims      = {};   // no verbatims — ever
    g.trustAvg = g.proactivityAvg = g.productivityAvg = null;
    g.tp3Index = g.impactAvg = g.benchAvg = g.g1Avg = g.g2Avg = null;
  };

  // 1. Primary suppression — any named group that responded but fell under MIN_N.
  //    (n === 0 means nobody responded; there is nothing to withhold.)
  for (const k of NAMED) {
    const n = result[k]?.n || 0;
    if (n === 0 || n >= MIN_N) continue;
    suppress(k, `Only ${n} of this group responded. A group needs at least ${MIN_N} responses before it can be reported separately.`);
    withheld.push({ key: k, label: result[k].label, n, reason: 'below_minimum' });
  }

  // 2. Complementary suppression — close the subtraction hole.
  const poolN     = result[POOL]?.n || 0;
  const shownKeys = () => NAMED.filter(k => !result[k].suppressed && (result[k].n || 0) > 0);
  const shownN    = () => (result.supervisor?.n || 0) + shownKeys().reduce((s, k) => s + (result[k].n || 0), 0);

  let residual = poolN - shownN();
  for (let guard = 0; guard < NAMED.length && residual > 0 && residual < MIN_N; guard++) {
    const smallest = shownKeys().sort((a, b) => (result[a].n || 0) - (result[b].n || 0))[0];
    if (!smallest) break;
    const n = result[smallest].n;
    suppress(smallest, `Withheld to protect the ${residual} rater${residual === 1 ? '' : 's'} in the suppressed groups. If this group were shown, their scores could be recovered by subtracting it from the overall average.`);
    withheld.push({ key: smallest, label: result[smallest].label, n, reason: 'residual_protection' });
    residual = poolN - shownN();
  }

  // 3. If the confidential pool itself (everyone except the supervisor) is under
  //    MIN_N, there is no safe aggregate to report at all. Suppress the pool and
  //    let the coach gate block the report.
  const confidentialN = poolN - (result.supervisor?.n || 0);
  if (confidentialN > 0 && confidentialN < MIN_N) {
    suppress(POOL, `Only ${confidentialN} confidential rater${confidentialN === 1 ? '' : 's'} responded in total — fewer than the ${MIN_N} required for any aggregate to be anonymous.`);
  }

  // Scrub suppressed groups' verbatims out of the All Others pool. Their SCORES
  // stay in the pool average (that is the whole point — nothing is deleted, it
  // just stops being separately countable). Their WORDS do not, because words
  // identify their author no matter which bucket they are filed under.
  if (orphanedText.size && result[POOL]?.verbatims) {
    for (const code of Object.keys(result[POOL].verbatims)) {
      result[POOL].verbatims[code] = result[POOL].verbatims[code].filter(t => !orphanedText.has(t));
    }
  }

  result._confidentiality = {
    minN:             MIN_N,
    poolN,
    confidentialN,
    residual,                                   // raters folded into All Others only
    supervisorReported: (result.supervisor?.n || 0) > 0,
    withheld,
    poolSuppressed:   !!result[POOL]?.suppressed,
    // The report can still be generated — but the coach must acknowledge what is
    // being withheld first. Acknowledging does NOT unsuppress anything.
    requiresAck:      withheld.length > 0 || !!result[POOL]?.suppressed,
  };
}

// ── Format per-group data for the Claude prompt ──────────────────────────────
function formatRaterGroupDataForPrompt(gd, diag) {
  // Only groups that survived min-n suppression are ever shown to the model.
  // A suppressed group has no column, no count, and no verbatims — the model
  // cannot leak what it was never given.
  const ALL_GRPS = [
    ['direct_report', 'DR'],
    ['peer', 'Peer'],
    ['supervisor', 'Supr'],
    ['internal_partner', 'IntP'],
    ['board', 'Board'],
    ['other_colleagues', 'Other'],
    ['self', 'Self'],
    ['all_others', 'All-Oth'],
  ];
  // A renamed group is referred to by its NEW name everywhere in the prompt —
  // column headers, item rows, verbatim attributions. The model must never see
  // the word "Peers" for a group the coach has renamed "Chiefs / Leadership Team".
  const GRPS = ALL_GRPS
    .filter(([g]) => {
      const grp = gd[g];
      if (!grp || grp.suppressed) return false;
      if (g === 'self') return true;
      return (grp.n || 0) > 0;
    })
    .map(([g, abbr]) => [g, (gd[g]?.renamed ? gd[g].label : abbr)]);
  const f = v => (v != null ? v.toFixed(2) : 'n/a');
  const row = (name, key) => {
    const vals = GRPS.map(([g]) => f(gd[g]?.[key]).padStart(5)).join(' | ');
    return `${name.padEnd(22)}| ${vals}`;
  };

  const lines = [];

  // ── Rater group names — AUTHORITATIVE. The relationship a leader picks when
  //    building their rater list does not always match the org chart, so the coach
  //    can rename a group. When they do, the NEW NAME defines what that group IS.
  //    The system prompt's default gloss ("Peers — cross-functional follow-through")
  //    must not be applied to a group that has been renamed to something else, or
  //    the report will interpret a leader's own executive team as outside peers.
  const renamed = ALL_GRPS
    .map(([g]) => gd[g])
    .filter(x => x && x.renamed && !x.suppressed && ((x.n || 0) > 0 || x.label === gd.self?.label));
  if (renamed.length) {
    lines.push('=== RATER GROUP NAMES (AUTHORITATIVE — THESE OVERRIDE THE DEFAULT NAMES) ===');
    lines.push('The coach has renamed one or more rater groups because the relationship labels the leader chose did not match the real org chart.');
    for (const g of renamed) {
      lines.push(`  · "${g.label}"  (was: ${g.defaultLabel})`);
    }
    lines.push('RULES:');
    lines.push('  1. Use these exact names everywhere — headings, tables, narrative, and quote attributions.');
    lines.push('  2. NEVER use the old default name for a renamed group. Do not write "Peers" for a group now called something else.');
    lines.push('  3. The NAME defines what the group is. Do NOT apply the default meaning of the old category to it. If a group is named for the leader\'s own executive team, interpret it as their closest-in reports — daily trust, safety, delegation — not as outside peers.');
    lines.push('');
  }
  if (diag && diag.rater_group_note && String(diag.rater_group_note).trim()) {
    lines.push('=== NOTE ABOUT WHO IS IN EACH GROUP (STATE THIS PLAINLY IN THE REPORT) ===');
    lines.push(String(diag.rater_group_note).trim());
    lines.push('Include this as a short "How to read the rater groups" note near the top of the report, in the leader\'s language. Do not editorialize it or soften it.');
    lines.push('');
  }

  // ── Confidentiality preamble — must come FIRST so the model never tries to
  //    describe, count, or apologize for a group it cannot see. Saying "we only
  //    heard from one peer" would defeat the entire suppression.
  const conf = gd._confidentiality;
  if (conf && (conf.withheld?.length || conf.poolSuppressed)) {
    lines.push('=== CONFIDENTIALITY — READ BEFORE ANYTHING ELSE ===');
    lines.push(`One or more rater groups did not reach the minimum of ${conf.minN} respondents. They have been REMOVED from the data below entirely.`);
    lines.push('Their scores are still inside the All Others averages. They have no column, no count, no scores, and no verbatims of their own.');
    lines.push('HARD RULES — a violation of any one of these makes the report unusable:');
    lines.push('  1. Write the report using ONLY the rater groups that appear in the table below.');
    lines.push('  2. NEVER mention, name, count, imply, apologize for, or speculate about any group that is absent.');
    lines.push('  3. NEVER write "no peer data," "only one peer responded," "we did not hear from," "response rates were low," or anything equivalent. Absence is not a finding — do not narrate it.');
    lines.push('  4. NEVER attribute a quote or a theme to a group that is not in the table.');
    lines.push('  5. Do not infer a missing group\'s view from the gap between a shown group and All Others.');
    lines.push('');
  }

  lines.push('=== TP3 SCORES BY RATER GROUP (scale 1-5 unless noted) ===');
  lines.push(`\n${'Dimension'.padEnd(22)}| ${GRPS.map(([, l]) => l.padStart(5)).join(' | ')}`);
  lines.push('-'.repeat(70));
  lines.push(row('Trust (A1-A7)', 'trustAvg'));
  lines.push(row('Proactivity (B1-B6)', 'proactivityAvg'));
  lines.push(row('Productivity (C1-C6)', 'productivityAvg'));
  lines.push(row('TP3 Index', 'tp3Index'));
  lines.push(row('Impact D1', 'impactAvg'));
  lines.push(row('Bench (F1-F2)', 'benchAvg'));
  if (gd.all_others?.g1Avg != null || gd.self?.g1Avg != null) lines.push(row('G1 Vision Align', 'g1Avg'));
  if (gd.all_others?.g2Avg != null || gd.self?.g2Avg != null) lines.push(row('G2 GPS Gap Probe', 'g2Avg'));
  lines.push(`\nRater counts: ${GRPS.map(([g, lbl]) => `${lbl}: ${gd[g]?.n ?? 0}`).join(' | ')}`);

  // Item-level scores
  lines.push('\n=== ITEM-LEVEL SCORES ===');
  const ITEM_SECTIONS = [
    { label: 'TRUST (A1–A7)', codes: ['A1','A2','A3','A4','A5','A6','A7'] },
    { label: 'PROACTIVITY (B1–B6)', codes: ['B1','B2','B3','B4','B5','B6'] },
    { label: 'PRODUCTIVITY (C1–C6)', codes: ['C1','C2','C3','C4','C5','C6'] },
    { label: 'BENCH (F1–F2)', codes: ['F1','F2'] },
  ];
  if (diag.custom_g1_question) ITEM_SECTIONS.push({ label: 'G1 VISION ALIGNMENT', codes: ['G1'] });
  if (diag.custom_g2_question) ITEM_SECTIONS.push({ label: 'G2 CUSTOM QUESTION', codes: ['G2'] });
  if (diag.custom_g3_question) ITEM_SECTIONS.push({ label: 'G3 CUSTOM QUESTION', codes: ['G3'] });

  for (const { label, codes } of ITEM_SECTIONS) {
    lines.push(`\n${label}:`);
    for (const c of codes) {
      const qText = QUESTIONS[c] || (c === 'G1' ? diag.custom_g1_question : c === 'G2' ? diag.custom_g2_question : c === 'G3' ? diag.custom_g3_question : null) || c;
      const vals = GRPS.map(([g]) => f(gd[g]?.avgScores?.[c]).padStart(5)).join(' | ');
      lines.push(`  ${c}: ${qText.slice(0, 65)}${qText.length > 65 ? '…' : ''}`);
      lines.push(`     → ${vals}  (${GRPS.map(([, l]) => l).join(' | ')})`);
    }
  }

  // Verbatims by group
  lines.push('\n=== VERBATIM RESPONSES BY RATER GROUP ===');
  const VERB_SECTIONS = [
    { label: 'Trust verbatims (A8–A10)', codes: ['A8','A9','A10'] },
    { label: 'Proactivity verbatims (B7–B10)', codes: ['B7','B8','B9','B10'] },
    { label: 'Productivity verbatims (C7–C9)', codes: ['C7','C8','C9'] },
    { label: 'Impact comments (D2)', codes: ['D2'] },
    { label: 'Bench/succession comments (F3)', codes: ['F3'] },
    { label: 'Custom question written answers (G2–G3)', codes: ['G2','G3'] },
  ];
  const NON_SELF = GRPS.filter(([g]) => g !== 'self' && g !== 'all_others');
  for (const { label, codes } of VERB_SECTIONS) {
    const groupLines = [];
    for (const [gKey, gLbl] of NON_SELF) {
      const quotes = codes.flatMap(c => (gd[gKey]?.verbatims?.[c] || []).map(v => `    "${v}"`));
      if (quotes.length > 0) { groupLines.push(`  [${gLbl}]:`); groupLines.push(...quotes); }
    }
    if (groupLines.length > 0) { lines.push(`\n${label}:`); lines.push(...groupLines); }
  }

  return lines.join('\n');
}

// ── Full-report system prompt (Option B) ────────────────────────────────────
const REPORT_SYSTEM_PROMPT = `You are writing a GPS Leadership 14-Day Executive Leadership Diagnostic Report. This is a client-facing document — the leader will read every word. No coach-facing notes, no "Note to coach" lines, no internal commentary.

VOICE AND TONE RULES — follow these exactly:
1. Write to the leader in second person ("you," "your," "your team").
2. Use behavioral, neutral language. Describe actions and patterns, not character or motive. Write "raters noted inconsistent follow-through on commitments" — not "you have a blind spot." Write "others experience limited delegation" — not "you are micromanaging."
3. Word choice: use "gap" and "signal" 90% of the time. Reserve "blind spot" for at most 2 uses in the entire report — only for the largest discrepancies. Never write "operating below her/his level" or performance-review language. Tier labels are descriptive, not verdicts (e.g., "Developing: a solid foundation with clear room to grow in delegation and psychological safety").
4. Interpretations must be labeled: "A likely interpretation is…" Limit to 1–2 sentences.
5. Max paragraph length: 4 sentences. Use bullets whenever listing 2 or more items.
6. If you reference interim checks (e.g., 30-day follow-up), connect them to the 90-day target in the same sentence.
7. In narrative, lead with the behavior description, put the question code in parentheses after: "Following through on commitments (A3) scored 2.00 from supervisors…" — not "A3 ('Manages commitments…') scored 2.00."
8. Quote verbatims with <blockquote class="rater-quote">text — [Rater Group]</blockquote>. Group attribution only, never individual.
9. No coach-facing notes, no "Note to coach," no internal commentary anywhere in the output.
10. Name every strength and gap with a descriptive title, not an item code.

THE GPS TP3™ FRAMEWORK:
Trust (A1–A7): Consistency, follow-through, psychological safety, honest conversation.
Proactivity (B1–B6): Anticipating problems, bringing solutions, moving without being pushed.
Productivity (C1–C6): High-value output, time leverage, helping others perform.
Overall Impact (D1): Direct overall-impact rating by raters (the score line states its scale).
Bench Strength (F1–F2): Developing the people around this leader.
Custom items (G1, G2): Diagnostic-specific questions.

SCORING TIERS (1–5 scale) — the high-performing bar is 4.0. NEVER round up: a 3.6 is a 3, not "almost a 4." Do NOT call anything under 4.0 "solid," "good," or "healthy."
4.5–5.0 = Exceptional (4+ — keep, develop, and grow these people) | 4.0–4.4 = Strong (4+ — keep and grow) | 3.0–3.9 = Developing (under the 4.0 bar; counts as a 3; needs a deliberate development plan — frame as a concern to fix, not a win) | 2.0–2.9 = Red Flag (significant gap; build a development-or-role-fit plan) | Below 2.0 = Critical Gap (urgent role-fit decision)

RATER GROUPS: Direct Reports — daily trust and safety. Peers — cross-functional follow-through. Supervisors — strategic presence, upward accountability. Internal Partners — coordination reliability. Self vs. All Others: Self higher = possible gap in self-perception; Self lower = under-confidence or self-awareness.

90-DAY COHERENCE RULE: The single focus behavior chosen in Section 1D (90-Day Focus) is the organizing spine of this entire report. Copy that exact sentence to open Section 10 (90-Day Plan). Each pillar's 90-Day Implication (Start/Stop/Measure) must connect to that same focus behavior — Trust implication = psychological safety in the context of delegation; Proactivity implication = team anticipatory thinking on delegated work; Productivity implication = time audit tied to what was delegated. Do not invent three separate themes.

OUTPUT FORMAT — HTML only. No markdown. No preamble or postamble. Start immediately with the first section heading.
HTML elements:
• <h2 class="report-section"> — major headings
• <h3 class="report-subsection"> — subsection headings
• <p> — paragraphs (max 4 sentences)
• <table class="report-table"><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>
• <blockquote class="rater-quote">…</blockquote>
• <ul class="report-list"><li>…</li></ul>
• <strong> — key scores and critical phrases
• <div class="insight-callout">…</div> — callout blocks

REQUIRED SECTIONS — every heading below must appear, in this order. If any heading is missing, the report is incomplete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1: EXECUTIVE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Executive Summary</h2>

A. TP3 SNAPSHOT — <table class="report-table"> with two rows labeled "All Others" and "Self." Columns: TP3 Index | Trust | Proactivity | Productivity | Overall Impact (D1) | Bench Strength.

B. <h3 class="report-subsection">Top 3 Strengths</h3>
Three named strengths. Each: one <strong>descriptive header</strong> (not a question code) then 1–2 behavior-based sentences grounded in scores. Neutral and specific.

C. <h3 class="report-subsection">Top 3 Development Priorities</h3>
Three named priorities tied to score clusters. Each: one <strong>descriptive header</strong> then 1–2 sentences on the behavioral pattern and its execution cost.

D. <h3 class="report-subsection">90-Day Focus</h3>
ONE sentence. The single most important behavioral shift, synthesized from the data. This sentence will be repeated verbatim in Section 10.

E. <h3 class="report-subsection">Tool to Use</h3>
Name one GPS tool (e.g., GPS Delegation OS, Meeting Operating Standard, Own the Outcome™). One sentence on why.

F. <h3 class="report-subsection">Overall Impact</h3>
One sentence anchoring D1 to its tier and what it signals.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2: HOW TO READ THIS DIAGNOSTIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">How to Read This Diagnostic: Reality vs. Truth</h2>

Two short paragraphs only:

Paragraph 1: Raters observe behavior, not intent. The gap between what a leader intends and what others experience is where this diagnostic operates. Scores represent patterns across multiple independent observers — not any one person's opinion. The data does not say who is right; it shows what people experience.

Paragraph 2: Customize with the leader's actual self-vs-All-Others pattern. Write something like: "[Name]'s self-scores [align closely with / diverge from] rater scores across most dimensions. The sharpest gap appears in [pillar], where self-rated [X.XX] vs. All Others [X.XX] — a [gap/signal] worth sitting with. The most useful question is not 'do I agree?' but 'what would need to be true for this to be accurate?'"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3: OVERVIEW & TP3 LEADERSHIP OUTCOMES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Overview & TP3 Leadership Outcomes</h2>

Immediately after this heading, include the following GPS standard VERBATIM — do not paraphrase, soften, shorten, or omit it:
<div class="insight-callout"><strong>Why we measure against a 4.0 bar</strong><p>High-performing teams and organizations are built of 4s and 5s, so we hold every score to that standard on purpose. A 4&ndash;5 is a strength to protect, develop, and grow. A score in the 3s is a development zone &mdash; not a failure, but not &ldquo;good enough&rdquo; either; it gets a clear plan to reach a 4+. A 1&ndash;2 is a red flag that warrants a direct, honest conversation about fit. We don&rsquo;t grade on a curve, because your organization wasn&rsquo;t built to be average.</p></div>

A. Participant count and group breakdown (2 sentences or small table).

B. 1 paragraph overall narrative — what the TP3 Index and tier tell us about this leader's current impact. Be direct and specific to this person's data.

C. Full rater group table — <table class="report-table">. Rows: Trust | Proactivity | Productivity | TP3 Index | Overall Impact (D1) | Bench Strength. Columns: Direct Reports | Peers | Supervisors | Int'l Partners | Self | All Others. Show n/a where no raters.

D. Per-pillar summaries. For each pillar (Trust, Proactivity, Productivity):
— 2 sentences on the key pattern (score spread, strongest/weakest specific behaviors using behavior descriptions not codes, any notable rater group divergence).
— One <div class="insight-callout"> with heading <strong>90-Day Implication — [Pillar]</strong> and three bullets:
  <ul class="report-list"><li><strong>Start:</strong> [behavior tied to the Section 1D focus behavior]</li><li><strong>Stop:</strong> [behavior tied to the Section 1D focus behavior]</li><li><strong>Measure:</strong> [observable signal]</li></ul>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4: LAYERED PERSPECTIVES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Layered Perspectives: What Each Group Sees</h2>

For each rater group with responses: 2 bullet points describing what that group observes, then 1 verbatim quote in <blockquote class="rater-quote"> tags. Skip groups with no data. Keep this section tight — it is a perspective summary, not a deep dive.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5: INTENT VS. IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Intent vs. Impact</h2>

A. Two bullet lists side by side (use two <ul class="report-list"> with short headings):
<strong>How you see yourself (intent):</strong> — 3–4 bullets using self-scores and self-assessment comments, in plain behavioral language.
<strong>How others see you (impact):</strong> — 3–4 bullets using the biggest TP3 gaps and 1–2 key rater quotes.

B. Self vs. Others gap table — Dimension | Self Score | All Others Score | Gap (+/−) | Signal. Rows: Trust, Proactivity, Productivity, TP3 Index, Bench Strength, G1 (if exists), G2 (if exists). Gap guide: >+0.5 = likely gap in self-perception | +0.2 to +0.5 = minor gap | −0.2 to +0.2 = aligned | <−0.2 = under-confidence.

C. 2–3 reflection questions. Plain, direct. Example: "Where do you see your impact differently than your team does — and what would need to be true for their view to be accurate?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6: KEY STRENGTHS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Key Strengths</h2>

3 named strengths (restate from Section 1B with fuller explanation — not a copy-paste). For each: <h3 class="report-subsection">[Strength Name]</h3>
• <strong>Evidence:</strong> scores and 1 verbatim confirming this strength.
• <strong>Why it matters:</strong> one sentence on the business consequence of this strength for this leader's specific context.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 7: BLIND SPOTS & OPPORTUNITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Blind Spots & Opportunities</h2>

3 named themes. For each: <h3 class="report-subsection">[Theme Name]</h3>
• <strong>What stakeholders are experiencing:</strong> the specific behavioral pattern others observe. Neutral — describe behavior and its effect, not character.
• <strong>Opportunity:</strong> what to do differently and the likely business effect in 90 days.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 8: ORGANIZATIONAL & TEAM IMPACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Organizational & Team Impact Translation</h2>

Three short bullet groups (2–3 bullets each, not paragraphs):
• <strong>Execution & Results:</strong> how this leader's profile affects the team's ability to deliver on commitments.
• <strong>Culture & Trust:</strong> what the trust and proactivity signals create in the day-to-day environment.
• <strong>Succession & Scalability:</strong> what the Bench Strength score and succession data say about pipeline investment.

Ground every bullet in a specific score or verbatim. No generic leadership theory.

After the Succession & Scalability bullets, add this exact note in its own line: <p class="report-note" style="font-size:13px;color:#555;font-style:italic;">The readiness and bench signals above come from perception data in the diagnostic. They are real input and worth acting on, but they are not a complete picture. Combine them with recent performance results, the actual requirements of the next role, and HR or risk guidance before making any promotion or succession decision. The chart informs the call; the leaders accountable for the business make it.</p>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 9: START. STOP. CONTINUE.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Start. Stop. Continue. — and How to Use It</h2>

Open with exactly this framing (adapt names/details only): "This list is designed to be shared directly with your team. Leadership accountability is most effective when it is public and specific — not just an internal intention. Consider reading the Start and Stop items aloud in your next team meeting and inviting your team to hold you to them."

Then three <ul class="report-list"> lists:
• <strong>START</strong> — 3–5 concrete behaviors to add, aligned with the 90-day focus (delegation, psychological safety, or productivity, depending on the data).
• <strong>STOP</strong> — 3–5 behaviors currently creating friction, tied to the gap themes.
• <strong>CONTINUE</strong> — 3–5 behaviors that are working and must be protected.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 10: 90-DAY LEADERSHIP IMPACT PLAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">90-Day Leadership Impact Plan (Pre-Wired Focus)</h2>

A. <h3 class="report-subsection">Pre-Wired Focus Behavior</h3>
Copy verbatim the sentence from Section 1D here. This is the organizing spine — all elements below connect to it.

B. <h3 class="report-subsection">Success Metric</h3>
Exactly this format:
<ul class="report-list">
<li><strong>What we're measuring:</strong> [name the metric]</li>
<li><strong>How it's measured:</strong> [method — e.g., 30-day rater check-in (connected to 90-day target), direct team observation, structured pulse]</li>
<li><strong>Baseline:</strong> [ ] (to be captured in debrief session)</li>
<li><strong>90-Day Target:</strong> [ ] (to be set in debrief session)</li>
</ul>

C. <h3 class="report-subsection">Weekly Practices</h3>
4–6 specific practices, each one sentence with an action verb. At least one must explicitly name a GPS tool (e.g., "Use the GPS Delegation OS each Monday to identify one decision to hand off in writing, and confirm receipt before end of day Friday"). All practices should connect to the focus behavior, not be random habits.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 11: APPENDICES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<h2 class="report-section">Appendix I: Verbatim Feedback by Rater Group</h2>
All significant verbatims not already quoted above, organized by rater group. Label source as rater group only. Include everything worth reading. If no additional verbatims remain, write: "All relevant verbatims have been cited in the body of this report."

<h2 class="report-section">Appendix II: Question-Level Scores</h2>
Table: Question | Behavior Description | All Others Avg | Self Score. All rated questions (A1–G2). Show n/a where data is absent.

<h2 class="report-section">Appendix III: GPS Tools Referenced</h2>
For each GPS tool mentioned in this report: tool name + one sentence on what it is and how it connects to this leader's priorities. If no tool was referenced other than the one in Section 10, note it with a 1-sentence description.

Write the complete report now. Every heading above is required — output them all even if a section is data-thin. Prioritize density: every sentence earns its place. No filler. No generic observations. No coach-facing commentary.`;


async function handleGenerateReport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  // Coach-session gate: this endpoint returns a report built from the leader's
  // private self-assessment + coaching/interview notes — never expose it anon.
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_id,client_name,client_title,client_org,close_date,tier,custom_g1_question,custom_g2_question,custom_g3_question,self_three_year_vision,self_future_self_capabilities,self_immediate_successor_view,self_successor_candidates,self_successor_development_actions,intake_notes,coaching_notes,interview_notes,interview_notes_json,impact_scale,rater_group_labels,rater_group_note&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    // Optional: the client's company website, used as light background context only.
    let clientWebsite = null;
    if (diag.client_id) {
      try {
        const cRes = await sb(`/rest/v1/clients?id=eq.${diag.client_id}&select=website&limit=1`);
        const cRows = await cRes.json();
        clientWebsite = (Array.isArray(cRows) && cRows[0]?.website) ? cRows[0].website : null;
      } catch (_) { /* non-fatal */ }
    }

    // Fetch ALL completed raters (self + non-self) so we can compute per-group scores
    const allRatersRes = await sb(
      `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&completed_at=not.is.null&select=id,relationship,is_self`
    );
    const allRaters = await allRatersRes.json();
    if (!Array.isArray(allRaters) || allRaters.length === 0) {
      return res.status(400).json({ error: 'No completed responses found. Survey must be closed before generating a report.' });
    }
    const nonSelfRaters = allRaters.filter(r => !r.is_self);
    if (nonSelfRaters.length === 0) {
      return res.status(400).json({ error: 'No external rater responses found. At least one rater must complete the survey before generating a report.' });
    }
    const raterIds = allRaters.map(r => r.id);

    // Fetch ALL responses for the diagnostic — anonymous rows have rater_id NULL
    // and would be dropped by a rater_id=in.(...) filter. Linked rows are still
    // restricted to completed raters client-side.
    const completedIdSet = new Set(raterIds);
    const respRes = await sb(
      `/rest/v1/diagnostic_responses?diagnostic_id=eq.${diagnostic_id}&select=rater_id,question_code,score,text_response,rater_relationship`
    );
    const allResponseRows = await respRes.json();
    const responses = Array.isArray(allResponseRows)
      ? allResponseRows.filter(r => r.rater_id === null || completedIdSet.has(r.rater_id))
      : [];
    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ error: 'No responses found for this diagnostic.' });
    }

    const overridesRes = await sb(
      `/rest/v1/diagnostic_question_overrides?diagnostic_id=eq.${diagnostic_id}&select=question_code,override_text`
    );
    const overrides   = await overridesRes.json() || [];
    const overrideMap = Object.fromEntries(overrides.map(o => [o.question_code, o.override_text]));

    // Build per-group data for full report (Option B)
    const groupData = buildRaterGroupData(responses, allRaters, diag.rater_group_labels);

    // ── Confidentiality gate ──────────────────────────────────────────────
    // If any rater group fell under the minimum, the coach has to see what is
    // being withheld BEFORE a report is generated. Acknowledging does not
    // unsuppress anything — the data stays out either way. The coach is
    // acknowledging the loss, and choosing between generating without those
    // groups, chasing the outstanding raters, or extending the survey.
    // Gate runs before the Claude call so a blocked request costs nothing.
    const conf = groupData._confidentiality;
    if (conf?.requiresAck && !(req.body && req.body.confidentiality_ack === true)) {
      return res.status(409).json({
        error: 'confidentiality_review_required',
        message: conf.poolSuppressed
          ? `Only ${conf.confidentialN} confidential rater${conf.confidentialN === 1 ? '' : 's'} responded. That is below the minimum of ${conf.minN}, so no group and no aggregate can be reported without identifying them. Chase the outstanding raters or extend the survey.`
          : `${conf.withheld.length} rater group${conf.withheld.length === 1 ? '' : 's'} did not reach the ${conf.minN}-response minimum and will be withheld from this report.`,
        confidentiality: conf,
      });
    }

    // Also compute aggregate scores (non-self only) for scores_json backward compat
    const raterMetaMap = new Map(allRaters.map(r => [r.id, r]));
    const nonSelfResponses = responses.filter(r => !raterMetaMap.get(r.rater_id)?.is_self);
    const scores = buildScoreSummary(nonSelfResponses, (diag.impact_scale != null ? diag.impact_scale : 10));

    const versionsRes = await sb(
      `/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${diagnostic_id}&select=version&order=version.desc&limit=1`
    );
    const versions      = await versionsRes.json();
    const latestVersion = versions?.[0]?.version || 0;
    const nextVersion   = latestVersion + 1;

    // ── Cost ceiling: max 5 report generations per diagnostic ────────────
    const MAX_REPORT_DRAFTS = 20;
    if (latestVersion >= MAX_REPORT_DRAFTS) {
      return res.status(429).json({
        error: `Report generation limit reached (${MAX_REPORT_DRAFTS} drafts maximum). Contact support if you need to regenerate.`,
        draft_count: latestVersion,
      });
    }

    const overrideNotes = Object.keys(overrideMap).length > 0
      ? `\nNote — question text overrides in effect: ${Object.entries(overrideMap).map(([k,v]) => `${k}: "${v}"`).join('; ')}`
      : '';

    // Per-interview write-ups live in interview_notes_json [{name,date,notes}],
    // NOT the legacy interview_notes text field. Serialize them so the 1:1
    // interviews actually inform the report.
    const interviewEntries = Array.isArray(diag.interview_notes_json) ? diag.interview_notes_json : [];
    const interviewsText = interviewEntries.map((iv, i) => {
      const nm = (iv && iv.name) ? String(iv.name).trim() : `Interview ${i + 1}`;
      const dt = (iv && iv.date) ? ` (${iv.date})` : '';
      const nt = (iv && iv.notes) ? String(iv.notes).trim() : '';
      return nt ? `--- 1:1 Interview: ${nm}${dt} ---\n${nt}` : '';
    }).filter(Boolean).join('\n\n');
    const coachNotesSection = (diag.intake_notes || diag.coaching_notes || diag.interview_notes || interviewsText)
      ? `\n=== COACH NOTES (CONFIDENTIAL — FOR REPORT CONTEXT ONLY) ===
${diag.intake_notes    ? `Kick-off / Intake Notes:\n${diag.intake_notes}\n`    : ''}${diag.coaching_notes  ? `Coaching Notes:\n${diag.coaching_notes}\n`        : ''}${diag.interview_notes ? `General Interview Notes:\n${diag.interview_notes}\n`      : ''}${interviewsText ? `\n1:1 INTERVIEW WRITE-UPS:\n${interviewsText}\n` : ''}`.trimEnd()
      : '';

    const userPrompt = `LEADER: ${diag.client_name}${diag.client_title ? `, ${diag.client_title}` : ''}${diag.client_org ? ` — ${diag.client_org}` : ''}
DIAGNOSTIC TIER: ${diag.tier || 'standard'}${clientWebsite ? `\nCOMPANY WEBSITE (background context only — may be outdated; do NOT treat as authoritative or quote it; use lightly to make language relevant to the organization): ${clientWebsite}` : ''}
${diag.custom_g1_question ? `\nCUSTOM G1 QUESTION (Vision Alignment): "${diag.custom_g1_question}"` : ''}${diag.custom_g2_question ? `\nCUSTOM G2 QUESTION (coach + leader): "${diag.custom_g2_question}"` : ''}${diag.custom_g3_question ? `\nCUSTOM G3 QUESTION (coach + leader): "${diag.custom_g3_question}"` : ''}${overrideNotes}

${formatRaterGroupDataForPrompt(groupData, diag)}

=== SELF-ASSESSMENT — SUCCESSION & FUTURE SELF (LEADER ONLY, CONFIDENTIAL) ===
3-Year Vision: ${diag.self_three_year_vision || 'Not provided'}
Future self / capabilities needed: ${diag.self_future_self_capabilities || 'Not provided'}
View of immediate successor readiness: ${diag.self_immediate_successor_view || 'Not provided'}
Successor candidates identified: ${diag.self_successor_candidates || 'Not provided'}
Successor development actions underway: ${diag.self_successor_development_actions || 'Not provided'}
${coachNotesSection}

Write the complete 14-Day Executive Leadership Diagnostic Report for ${diag.client_name} now.`.trim();

    // Sonnet + 8000 tokens — no retry, 280s hard timeout (Vercel Pro 300s ceiling)
    // Quality-first mode: give Claude full room to produce a complete 11-section report
    const raw = await callClaude(REPORT_SYSTEM_PROMPT, userPrompt, 8000, { retries: 0, model: CLAUDE_REPORT_MODEL, timeoutMs: 280000 });

    // Output is full HTML — prepend branded cover before storing
    const reportDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const clientLine = [diag.client_name, diag.client_title, diag.client_org].filter(Boolean).join(' · ');
    const brandedCover = `<div class="report-cover">
  <div class="report-cover-logo">GPS LEADERSHIP SOLUTIONS</div>
  <div class="report-cover-subtitle">14-Day Executive Leadership Diagnostic Report</div>
  <div class="report-cover-client">${clientLine}</div>
  <div class="report-cover-meta">
    <span>Prepared by: Alex D. Tremble, CEO &nbsp;·&nbsp; GPS Leadership Solutions</span>
    <span>${reportDate}</span>
    <span class="report-confidential-badge">CONFIDENTIAL</span>
  </div>
</div>
<hr class="report-cover-divider">
`;
    const reportHtml = brandedCover + raw.trim();
    if (!reportHtml) {
      return res.status(500).json({ error: 'Claude returned an empty report. Please try again.' });
    }
    // Basic sanity check — should contain at least one heading tag
    if (!reportHtml.includes('<h2') && !reportHtml.includes('<h3')) {
      console.error('[diagnostic/generate-report] Unexpected output (no headings). First 500 chars:\n', reportHtml.slice(0, 500));
      return res.status(500).json({ error: 'Claude returned unexpected content. Please try again.', raw: reportHtml.slice(0, 500) });
    }

    const now = new Date().toISOString();
    const draftRes = await sb('/rest/v1/diagnostic_report_drafts', 'POST', {
      diagnostic_id,
      version:         nextVersion,
      content_json:    {
        report_format: 'html_v2',
        generated_with_model: CLAUDE_REPORT_MODEL,
        rater_groups_used: Object.fromEntries(
          Object.entries(groupData).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, v.n])
        ),
        // Coach-facing audit trail of what was withheld and why. Never rendered to
        // the leader or the sponsor — this lives here so the decision is on record.
        confidentiality: groupData._confidentiality || null,
      },
      raw_markdown:    reportHtml,
      prompt_snapshot: userPrompt.slice(0, 3000),
      scores_json: {
        trust:        scores.trustScore,
        proactivity:  scores.proactivityScore,
        productivity: scores.productivityScore,
        tp3_index:    scores.tp3Index,
        impact:       scores.impactScore,
        bench:        scores.benchScore,
        g1:           scores.g1Score,
        g2:           scores.g2Score,
        rater_count:  scores.raterCount,
        per_question: scores.perQuestion,
        // by_group is the blob that reaches the LEADER (results-visual.js), the
        // COACH (coach.html) and the SPONSOR (decision-room.html via sponsor-data.js).
        // Suppressed groups are dropped here, at the single point they all read from,
        // so a group under MIN_N cannot surface on any of those surfaces.
        // `label` rides along so the leader, coach and sponsor views all show the
        // SAME name the report used. Without it, the PDF would say "Chiefs /
        // Leadership Team" while the portal still said "Peers" for the same people.
        by_group: Object.fromEntries(
          Object.entries(groupData)
            .filter(([k, v]) => !k.startsWith('_') && k !== 'all_others' && !v.suppressed)
            .map(([k, v]) => [k, { n: v.n, label: v.label, trust: v.trustAvg, proactivity: v.proactivityAvg, productivity: v.productivityAvg, tp3: v.tp3Index, bench: v.benchAvg }])
        ),
      },
      generated_at:   now,
    }, { Prefer: 'return=representation' });
    if (!draftRes.ok) {
      const errBody = await draftRes.text();
      throw new Error(`Failed to save report draft (HTTP ${draftRes.status}): ${errBody.slice(0, 300)}`);
    }
    const drafts = await draftRes.json();
    const draft  = Array.isArray(drafts) ? drafts[0] : drafts;

    const isPreview = !!(req.body && req.body.preview);
    await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH',
      isPreview
        ? { report_preview_at: now, updated_at: now }                       // private coach preview — survey stays OPEN, status unchanged, never visible to leader/sponsor
        : { status: 'report_draft', report_generated_at: now, updated_at: now },
      { Prefer: 'return=minimal' }
    );

    return res.status(200).json({
      draft_id:    draft?.id,
      version:     nextVersion,
      scores: {
        trust:        scores.trustScore,
        proactivity:  scores.proactivityScore,
        productivity: scores.productivityScore,
        tp3_index:    scores.tp3Index,
        impact:       scores.impactScore,
        bench:        scores.benchScore,
        rater_count:  scores.raterCount,
      },
      confidentiality: groupData._confidentiality || null,   // coach-facing only
      generated_at: now,
    });

  } catch (err) {
    console.error('[diagnostic/generate-report] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: finalize-report
// POST /api/diagnostic?action=finalize-report
// Body: { diagnostic_id }
// ═══════════════════════════════════════════════════════════════════════════════

function buildReportReadyEmail({ clientName, leaderTitle, leaderOrg, portalUrl, debriefDate, debriefTime, bodyHtml }) {
  const firstName = (clientName || '').split(' ')[0] || 'there';
  const orgLine   = [leaderTitle, leaderOrg].filter(Boolean).join(' — ');

  // Editable paragraph region — comes from the approved template when present,
  // otherwise the built-in default below (so the email is unchanged until edited).
  const defaultBody = `<p>Hi ${firstName},</p>
        <p>Your GPS Leadership Diagnostic report has been finalized${orgLine ? ` for <strong>${orgLine}</strong>` : ''}.</p>
        <p>Your results — including your TP3™ breakdown, rater feedback themes, and 90-day priorities — are now available in your portal.</p>`;
  const bodyContent = bodyHtml || defaultBody;

  // Pre-debrief framing: when the debrief date is set, state date (+ time) and
  // ask the leader to review the report in-portal beforehand.
  let whenLine = '';
  if (debriefDate) {
    const d = new Date(String(debriefDate) + 'T12:00:00');
    if (!isNaN(d.getTime())) {
      whenLine = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (debriefTime) whenLine += ' at ' + debriefTime;
    }
  }
  const debriefSection = whenLine
    ? `<div style="margin:24px 0;background:#f0f4ff;border:1.5px solid #1A3D6E;border-radius:8px;padding:16px 20px;">
         <div style="font-size:14px;font-weight:700;color:#1A3D6E;margin-bottom:4px;">📅 Your debrief session</div>
         <p style="margin:0;font-size:14px;color:#333;">We'll walk through your results together on <strong>${whenLine}</strong>. Please review your report in the portal beforehand so we can spend our time on what matters most: building your 90-day plan.</p>
       </div>`
    : `<p style="margin-top:24px;">We'll use your next session to walk through the findings and build your action plan.</p>`;

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Leadership Report Is Ready</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        ${bodyContent}
        <div style="margin:28px 0;text-align:center;">
          <a href="${portalUrl}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            View My Report →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${portalUrl}" style="color:#1A3D6E;">${portalUrl}</a></p>
        ${debriefSection}
        <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">
          You're receiving this because a GPS Leadership diagnostic was completed on your behalf.
          Questions? Reply to this email.
        </div>
      </div>
    </div>
  `;
}

async function handleFinalizeReport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' }); // P0-4 2026-07-01

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(diagnostic_id)) return res.status(400).json({ error: 'Invalid diagnostic_id' }); // P0-4

  try {
    // 1. Fetch the diagnostic
    const diagRes = await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=*`, 'GET', null,
      { Accept: 'application/vnd.pgrst.object+json' });
    if (!diagRes.ok) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = await diagRes.json();

    // 2. Fetch the client (to get portal token, email, name)
    const clientRes = await sb(`/rest/v1/clients?id=eq.${diag.client_id}&select=*`, 'GET', null,
      { Accept: 'application/vnd.pgrst.object+json' });
    if (!clientRes.ok) return res.status(404).json({ error: 'Client not found' });
    const client = await clientRes.json();

    // 2b. Validate client has a portal token — required for the report-ready email link
    if (!client.token) {
      return res.status(422).json({
        error: 'This client does not have a portal access link yet. Generate one from the client profile in the coach portal before finalizing.',
        code:  'NO_PORTAL_TOKEN',
      });
    }

    // 3. Mark diagnostic as finalized
    const now = new Date().toISOString();
    const updateRes = await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH',
      { status: 'report_final', report_finalized_at: now },
      { Prefer: 'return=minimal' });
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      return res.status(500).json({ error: `Failed to update diagnostic: ${errText}` });
    }

    // 4. Build portal URL
    const portalUrl = `${PORTAL_BASE}/client?token=${client.token}`;

    // 5. Send email to client
    // Editable template (Communication → Email Templates). Falls back to built-in copy.
    const firstName = (client.name || '').split(' ')[0] || 'there';
    let subject = 'Your GPS Leadership Report Is Ready';
    let bodyHtml = null;
    const tpl = await getApprovedTemplate('diagnostic_report_ready');
    if (tpl) {
      const vars = { first_name: firstName, leader_name: client.name || '', org: client.organization || '', title: client.title || '', portal_url: portalUrl };
      if (tpl.subject)   subject  = fillTemplate(tpl.subject, vars) || subject;
      if (tpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(tpl.body_text, vars));
    }

    const emailHtml = buildReportReadyEmail({
      clientName:  client.name,
      leaderTitle: client.title || null,
      leaderOrg:   client.organization || null,
      portalUrl,
      debriefDate: diag.debrief_date || null,
      debriefTime: diag.debrief_time || null,
      bodyHtml,
    });

    let emailId = null;
    try {
      emailId = await sendEmail({
        to:            client.email,
        subject,
        html:          emailHtml,
        emailType:     'report_ready',
        recipientName: client.name,
      });
    } catch (emailErr) {
      // Don't fail the whole request if email errors — report is still finalized
      console.error('[finalize-report] email error:', emailErr.message);
    }

    return res.status(200).json({
      ok:         true,
      portal_url: portalUrl,
      email_sent: !!emailId,
    });

  } catch (err) {
    console.error('[diagnostic/finalize-report] error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: reminders
// GET|POST /api/diagnostic?action=reminders
// Auth: x-vercel-cron header, Bearer CRON_SECRET, or a valid coach session { session }
// ═══════════════════════════════════════════════════════════════════════════════

function daysBetween(earlier, later) {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / (1000 * 60 * 60 * 24);
}

function daysFromNow(dateStr) {
  return daysBetween(new Date(), new Date(dateStr + 'T12:00:00'));
}

function buildReminderEmail({ raterName, leaderName, surveyLink, closeDate, isSecond, bodyHtml, subjectOverride }) {
  const firstName = (raterName || '').split(' ')[0] || 'there';
  const closeFmt  = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'soon';
  const urgency = isSecond
    ? `<p><strong>The survey closes ${closeFmt}.</strong> This is your last reminder.</p>`
    : `<p>The survey closes on <strong>${closeFmt}</strong> — there's still time.</p>`;

  const defaultBody = `
          <p>Hi ${firstName},</p>
          <p>A quick follow-up — you haven't yet completed the feedback survey for <strong>${leaderName}</strong>.</p>
          ${urgency}
          <p>It takes 15–20 minutes. Your responses are confidential — individual answers are never shared.</p>`;
  const bodyContent = bodyHtml || defaultBody;

  return {
    subject: subjectOverride || (isSecond ? `Last reminder — ${leaderName} leadership feedback` : `Quick reminder — ${leaderName} leadership feedback`),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">${isSecond ? 'Final Reminder — ' : ''}Leadership Feedback Request</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          ${bodyContent}
          <div style="margin:28px 0;text-align:center;">
            <a href="${surveyLink}" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Complete the Survey →</a>
          </div>
          <p style="font-size:13px;color:#666;">Link: <a href="${surveyLink}" style="color:#1A3D6E;">${surveyLink}</a></p>
          <p>– Alex Tremble<br /><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;">If you've already completed the survey, please disregard this message.</div>
        </div>
      </div>
    `,
  };
}

function buildT2AlertEmail({ leaderName, closeDate, completedCount, totalInvited }) {
  const closeFmt = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'in 2 days';
  return {
    subject: `⚠️ T-2 Alert — ${leaderName} diagnostic (${completedCount}/${totalInvited} complete)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#8B1A1A;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#FFB3B3;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions — Diagnostic Alert</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Low Response Alert — ${leaderName}</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>This is an automated T-2 alert for the <strong>${leaderName}</strong> diagnostic.</p>
          <div style="background:#FFF3F3;border-left:4px solid #C0392B;padding:14px 18px;border-radius:0 6px 6px 0;margin:16px 0;">
            <strong>Survey closes: ${closeFmt}</strong><br />
            Completions: <strong>${completedCount} of ${totalInvited}</strong> raters<br />
            <strong>Minimum recommended: 7</strong>
          </div>
          <p>You may want to reach out directly to incomplete raters or extend the close date in the coach portal.</p>
          <div style="margin:28px 0;">
            <a href="${PORTAL_BASE}/coach" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;">Open Coach Portal →</a>
          </div>
          <p>– GPS Leadership Portal (automated)</p>
        </div>
      </div>
    `,
  };
}

function buildPlanLockedEmail({ leaderName, lockedAt }) {
  const lockedFmt = new Date(lockedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return {
    subject: `90-Day Plan auto-locked — ${leaderName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">90-Day Plan Auto-Locked</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>The 90-day plan for <strong>${leaderName}</strong> has been automatically locked.</p>
          <p>Lock date: <strong>${lockedFmt}</strong></p>
          <p>The plan was locked 24 hours after the debrief was marked complete. To unlock it manually, open the diagnostic in the coach portal.</p>
          <div style="margin:28px 0;">
            <a href="${PORTAL_BASE}/coach" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;">Open Coach Portal →</a>
          </div>
          <p>– GPS Leadership Portal (automated)</p>
        </div>
      </div>
    `,
  };
}

function buildPortalNudgeEmail({ clientName, leaderOrg, portalUrl, daysSince }) {
  const firstName = (clientName || '').split(' ')[0] || 'there';
  const orgLine   = leaderOrg ? ` at ${leaderOrg}` : '';
  return {
    subject: `Your GPS Leadership portal — a quick check-in`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Your portal is waiting for you.</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>Hey ${firstName},</p>
          <p>It's been a few days since you logged into your leadership portal${orgLine}. The tools are there when you need them — and the leaders who get the most out of this process are the ones who make it a quick weekly habit.</p>
          <p><strong>Two minutes is enough.</strong> Check your 90-day plan, ask a leadership question, or just see where things stand.</p>
          <div style="margin:28px 0 0;text-align:center;">
            <a href="${portalUrl}" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Open My Portal →</a>
          </div>
          ${(() => { try { return require('./brand-link').pasteLink(portalUrl, 'center'); } catch (_) { return ''; } })()}
          <p style="font-size:14px;color:#555;">If you have questions or something isn't working, reply to this email and I'll sort it out.</p>
          <p>– Alex<br><span style="font-size:13px;color:#888;">GPS Leadership Solutions</span></p>
        </div>
      </div>
    `,
  };
}

function buildAllCompleteEmail({ leaderName, completedCount, closeDate }) {
  const closeFmt = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : null;
  return {
    subject: `✅ All ${completedCount} raters complete — ${leaderName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#0B1F3B;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#a8b8cc;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions — Diagnostic Alert</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">100% Response Rate — ${leaderName}</div>
        </div>
        <div style="background:#f0f7f0;padding:20px 28px;border-bottom:3px solid #2e7d32;">
          <div style="font-size:15px;font-weight:700;color:#2e7d32;">All ${completedCount} raters have submitted their surveys.</div>
          ${closeFmt ? `<div style="font-size:13px;color:#555;margin-top:6px;">Survey window closes ${closeFmt} — you can close it early now if you'd like.</div>` : ''}
        </div>
        <div style="padding:20px 28px;">
          <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">
            Every stakeholder on <strong>${leaderName}</strong>'s list has responded.
            You now have a full data set — no need to wait for the close date.
          </p>
          <div style="background:#f5f5f5;border-radius:6px;padding:14px 18px;font-size:13px;color:#555;margin-bottom:20px;">
            <strong>Next step:</strong> Close the survey in the coach portal → Generate the report.
          </div>
          <a href="${process.env.PORTAL_BASE_URL || ''}/coach.html"
             style="display:inline-block;background:#C5A028;color:#fff;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;">
            Open Coach Portal →
          </a>
        </div>
        <div style="padding:12px 28px 20px;font-size:11px;color:#999;">
          This is an automated notification from GPS Leadership Solutions.
        </div>
      </div>
    `,
  };
}

function buildDeliveryAlertEmail({ errorCount, totalCount, errSummary }) {
  return {
    subject: `⚠ Email delivery alert — ${errorCount} failures in last 2h`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#8B1A1A;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#ffcccc;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions — System Alert</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">Email Delivery Spike Detected</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p><strong>${errorCount} of ${totalCount} emails</strong> sent in the last 2 hours failed.</p>
          <p>This may indicate a Resend API issue or domain authentication problem. Check your Resend dashboard immediately.</p>
          <pre style="background:#f5f5f5;padding:14px;border-radius:6px;font-size:12px;line-height:1.6;overflow-x:auto;">${errSummary}</pre>
          <div style="margin:24px 0;">
            <a href="https://resend.com/emails" style="background:#8B1A1A;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;">Open Resend Dashboard →</a>
          </div>
          <p style="font-size:13px;color:#666;">This alert will not repeat for 4 hours. – GPS Leadership Portal (automated)</p>
        </div>
      </div>
    `,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: sign-report-upload
// POST /api/diagnostic?action=sign-report-upload
// Body: { diagnostic_id, session }
//
// Post-v26 lockdown the browser's anon key can no longer INSERT into Storage, so
// the old direct db.storage.upload() of the final report PDF fails with
// "new row violates row-level security policy". This action uses the service key
// to mint a short-lived Storage signed upload URL (scoped to this diagnostic's
// report path) and returns its token. The coach's browser then uploads with
// db.storage.uploadToSignedUrl(path, token, file) — no anon write needed.
// Gated by the coach session token, same pattern as the other coach endpoints.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSignReportUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id)               return res.status(400).json({ error: 'diagnostic_id required' });

  const path = `${diagnostic_id}/report.pdf`;

  try {
    // x-upsert lets the coach replace a previously uploaded report at the same path.
    const signRes = await sb(
      `/storage/v1/object/upload/sign/diagnostic-reports/${path}`,
      'POST', {}, { 'x-upsert': 'true' }
    );
    if (!signRes.ok) {
      const t = await signRes.text();
      return res.status(502).json({ error: `Storage sign failed (${signRes.status}): ${t.slice(0, 200)}` });
    }
    const signJson = await signRes.json(); // { url: "/object/upload/sign/diagnostic-reports/<path>?token=<jwt>" }
    const token = new URL('http://x' + signJson.url).searchParams.get('token');
    if (!token) return res.status(502).json({ error: 'No upload token returned by Storage' });

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/diagnostic-reports/${path}`;
    return res.status(200).json({ token, path, publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: sign-team-report-upload
// POST /api/diagnostic?action=sign-team-report-upload   Body: { report_id, session }
// Mints a service-key signed upload URL so the coach can upload the branded team
// report PDF (anon storage writes are blocked post-v26). Path is scoped to the
// report id. Same mechanism as the individual report finalize.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSignTeamReportUpload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { report_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!report_id) return res.status(400).json({ error: 'report_id required' });

  const path = `team-reports/${report_id}.pdf`;
  try {
    const signRes = await sb(
      `/storage/v1/object/upload/sign/diagnostic-reports/${path}`,
      'POST', {}, { 'x-upsert': 'true' }
    );
    if (!signRes.ok) {
      const t = await signRes.text();
      return res.status(502).json({ error: `Storage sign failed (${signRes.status}): ${t.slice(0, 200)}` });
    }
    const signJson = await signRes.json();
    const token = new URL('http://x' + signJson.url).searchParams.get('token');
    if (!token) return res.status(502).json({ error: 'No upload token returned by Storage' });
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/diagnostic-reports/${path}`;
    return res.status(200).json({ token, path, publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: save-results-narrative
// POST /api/diagnostic?action=save-results-narrative
//   Body: { diagnostic_id, narrative:{headline,honest_read,supervisor_quote,team_quote}, session }
// Stores the coach-authored WORDS for the leader visual results page on
// diagnostics.results_narrative (numbers are never stored here — they come from the
// report draft's scores_json). Coach-session gated, service-key write. Survives
// report regeneration because it lives on the diagnostic, not the draft.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSaveResultsNarrative(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, narrative, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id)               return res.status(400).json({ error: 'diagnostic_id required' });

  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const n = narrative || {};
  const payload = {
    headline:         clean(n.headline, 200),
    honest_read:      clean(n.honest_read, 1200),
    sowhat:           clean(n.sowhat, 600),
    supervisor_quote: clean(n.supervisor_quote, 600),
    team_quote:       clean(n.team_quote, 600),
    updated_at:       new Date().toISOString(),
  };
  try {
    const r = await sb(
      `/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}`,
      'PATCH', { results_narrative: payload }, { Prefer: 'return=minimal' }
    );
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: `Save failed (${r.status}): ${t.slice(0, 200)}` }); }
    return res.status(200).json({ ok: true, narrative: payload });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS: structured report document (report_doc) — the single source of truth
// get-report-doc / save-report-doc / generate-report-section
// report_doc = { version, template, generated_at, source, sections:[{key,title,
//   audience,page_break_after,body}] }. The client snapshot, the 30/90-day plan
// prefill, and the sponsor page all draw from this. Coach-session gated; the
// sponsor never reads it (the Decision Room renders its own curated view).
// ═══════════════════════════════════════════════════════════════════════════════
const REPORT_SECTIONS = [
  { key:'cover',                title:'Cover',                                audience:'client' },
  { key:'exec_summary',         title:'Executive Summary',                    audience:'client' },
  { key:'how_to_read',          title:'How to Read This Diagnostic',          audience:'client' },
  { key:'overview_tp3',         title:'Overview & TP3 Leadership Outcomes',   audience:'client' },
  { key:'layered_perspectives', title:'Layered Perspectives',                 audience:'client' },
  { key:'intent_vs_impact',     title:'Intent vs. Impact',                    audience:'client' },
  { key:'key_strengths',        title:'Key Strengths',                        audience:'client' },
  { key:'blind_spots',          title:'Blind Spots & Opportunities',          audience:'client' },
  { key:'org_impact',           title:'Organizational & Team Impact',         audience:'client' },
  { key:'succession_future',    title:'Succession & Future Self',             audience:'client' },
  { key:'start_stop_continue',  title:'Start / Stop / Continue',              audience:'client' },
  { key:'plan_90day',           title:'90-Day Leadership Impact Plan',        audience:'client' },
  { key:'about_gps',            title:'About GPS Leadership Solutions',       audience:'client' },
  { key:'appendix_verbatim',    title:'Appendix: Selected Verbatim Feedback', audience:'client' },
];
const SECTION_MAX = 24000;
function reportScaffold() {
  return { version:1, template:'gps-14day-diagnostic-v1', generated_at:null, source:'scaffold',
    sections: REPORT_SECTIONS.map(function(s){ return { key:s.key, title:s.title, audience:s.audience, page_break_after:true, body:'' }; }) };
}

async function handleGetReportDoc(req, res) {
  const session = (req.body && req.body.session) || (req.query && req.query.session);
  const diagnostic_id = (req.body && req.body.diagnostic_id) || (req.query && req.query.diagnostic_id);
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id)               return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=report_doc`);
    const rows = await r.json();
    const doc = (rows && rows[0] && rows[0].report_doc) ? rows[0].report_doc : reportScaffold();
    return res.status(200).json({ ok:true, report_doc: doc, template: REPORT_SECTIONS });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function handleSaveReportDoc(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, report_doc, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id)               return res.status(400).json({ error: 'diagnostic_id required' });
  if (!report_doc || !Array.isArray(report_doc.sections)) return res.status(400).json({ error: 'report_doc.sections required' });
  const clean = (v,max)=> (typeof v==='string' ? v.slice(0,max) : '');
  const payload = {
    version: 1,
    template: clean(report_doc.template, 80) || 'gps-14day-diagnostic-v1',
    generated_at: report_doc.generated_at || null,
    source: clean(report_doc.source, 40) || 'coach-authored',
    updated_at: new Date().toISOString(),
    sections: report_doc.sections.slice(0, 40).map(function(s){
      return {
        key:   clean(s.key, 60),
        title: clean(s.title, 200),
        audience: (['client','sponsor','coach','all'].indexOf(s.audience) >= 0 ? s.audience : 'client'),
        page_break_after: s.page_break_after !== false,
        body:  clean(s.body, SECTION_MAX),
      };
    }),
  };
  try {
    const r = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}`,
      'PATCH', { report_doc: payload }, { Prefer:'return=minimal' });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error:`Save failed (${r.status}): ${t.slice(0,200)}` }); }
    return res.status(200).json({ ok:true, report_doc: payload });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

const REPORT_SECTION_SYSTEM = `You are an executive leadership assessment specialist for GPS Leadership Solutions, drafting ONE section of a 14-Day Executive Leadership Diagnostic report in Alex D. Tremble's voice: direct, candid, calm, plain language, short sentences, no hype, no motivational filler, no emoji. Address the leader as "you". Ground every claim in the rater data provided; never invent numbers. Describe behavior and observable impact, never personality labels. Return ONLY the section body text (plain text with simple line breaks; no markdown headers, no code fences, no preamble).`;

async function handleGenerateReportSection(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, section_key, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id || !section_key) return res.status(400).json({ error: 'diagnostic_id and section_key required' });
  const meta = REPORT_SECTIONS.find(function(s){ return s.key === section_key; }) || { key:section_key, title:section_key };
  try {
    const dr = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=client_name,client_title,report_doc`);
    const diag = (await dr.json())[0] || {};
    const sr = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${encodeURIComponent(diagnostic_id)}&select=scores_json&order=generated_at.desc&limit=1`);
    const scores = ((await sr.json())[0] || {}).scores_json || {};
    const exemplar = (diag.report_doc && Array.isArray(diag.report_doc.sections))
      ? ((diag.report_doc.sections.find(function(s){ return s.key === section_key; }) || {}).body || '') : '';
    const dataSummary = {
      leader: diag.client_name || 'the leader', role: diag.client_title || '',
      tp3_index: scores.tp3_index, trust: scores.trust, proactivity: scores.proactivity,
      productivity: scores.productivity, impact: scores.impact, bench: scores.bench,
      by_group: scores.by_group || {},
    };
    const user = `SECTION TO WRITE: "${meta.title}" (key: ${meta.key}).\n\nLEADER DATA (1-5 scale; use these exact numbers, do not invent):\n${JSON.stringify(dataSummary, null, 1)}\n\n${exemplar ? 'STYLE/STRUCTURE EXEMPLAR for this section (match this voice and shape; rewrite using THIS leader data):\n"""\n' + exemplar.slice(0,4000) + '\n"""\n\n' : ''}Write the "${meta.title}" section now. Plain text only.`;
    const body = await callClaude(REPORT_SECTION_SYSTEM, user, 1600, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, retries: 1 });
    return res.status(200).json({ ok:true, section_key: meta.key, body: (body || '').slice(0, SECTION_MAX) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-plan-prefill
// POST /api/diagnostic?action=generate-plan-prefill   Body: { diagnostic_id, session }
//
// Drafts the leader's recommended 90-day plan as the STRUCTURED wizard_prefill_data
// shape the client onboarding wizard already consumes. Generated coach-side from the
// diagnostic scores + the authored report_doc. The coach reviews/edits and approves;
// the approved object is saved to diagnostics.wizard_prefill_data (via the coach
// data proxy), so the leader opens an already-filled, editable plan. This endpoint
// only DRAFTS — it does not persist. Coach-session gated.
// ═══════════════════════════════════════════════════════════════════════════════
const PLAN_PREFILL_SYSTEM = `You are an executive leadership coach for GPS Leadership Solutions drafting a recommended 90-day development plan for a leader, based on their 14-Day Executive Leadership Diagnostic. Write in Alex D. Tremble's voice: direct, candid, plain, specific, no hype, no emoji. The plan must be concrete and behavior-based, grounded ONLY in the diagnostic data and report provided. Never invent metric numbers. Return ONLY a single JSON object, no prose, no code fences, exactly this shape:
{
  "key_theme": "one short phrase naming the central development theme",
  "scores": { "trust": <number|null>, "proactivity": <number|null>, "productivity": <number|null> },
  "suggested": {
    "pillar": "Trust | Proactivity | Productivity — the single recommended focus pillar for the next 90 days",
    "goal90": "one specific 90-day leadership goal statement",
    "goal30": "the 30-day milestone toward that goal",
    "behavior1": "the primary behavior to practice (specific, observable)",
    "behavior2": "an optional secondary behavior, or empty string",
    "metric1": { "name": "a self-tracked metric name", "baseline": <number|null>, "target": <number|null> },
    "metric2": { "question": "a single behavior stakeholders can rate 1-5", "targetAvg": 4.0 }
  }
}
Rules: "pillar" must be exactly one of Trust, Proactivity, or Productivity — the area most worth focusing on for the next 90 days (usually the lowest-scoring, but use the report context to judge), and the goal/behaviors must target that pillar first. Keep every field to one tight sentence. metric1 baseline/target are numbers only when the data supports them, else null. Do not include stakeholder names or any people.`;

async function handleGeneratePlanPrefill(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const dr = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=client_name,client_title,report_doc`);
    const diag = (await dr.json())[0] || {};
    const sr = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${encodeURIComponent(diagnostic_id)}&select=scores_json&order=generated_at.desc&limit=1`);
    const scores = ((await sr.json())[0] || {}).scores_json || {};
    // Leader-facing narrative sections that inform a plan, if authored.
    const wantKeys = ['key_strengths', 'blind_spots', 'start_stop_continue', 'plan_90day', 'org_impact', 'succession_future'];
    let narrative = '';
    if (diag.report_doc && Array.isArray(diag.report_doc.sections)) {
      narrative = diag.report_doc.sections
        .filter(function (s) { return wantKeys.indexOf(s.key) >= 0 && s.body; })
        .map(function (s) { return (s.title || s.key) + ':\n' + String(s.body).slice(0, 1500); })
        .join('\n\n');
    }
    const dataSummary = {
      leader: diag.client_name || 'the leader', role: diag.client_title || '',
      tp3_index: scores.tp3_index, trust: scores.trust, proactivity: scores.proactivity,
      productivity: scores.productivity, impact: scores.impact, bench: scores.bench,
    };
    const user = `LEADER DIAGNOSTIC DATA (1-5 scale; use these exact numbers, do not invent):\n${JSON.stringify(dataSummary, null, 1)}\n\n${narrative ? 'AUTHORED REPORT SECTIONS (base the plan on these):\n"""\n' + narrative.slice(0, 6000) + '\n"""\n\n' : ''}Draft the recommended 90-day plan JSON now.`;
    const raw = await callClaude(PLAN_PREFILL_SYSTEM, user, 1500, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, temperature: 0, retries: 1 });
    const parsed = parseJsonLoose(raw);
    if (!parsed || !parsed.suggested) return res.status(502).json({ error: 'Could not parse plan draft from the model. Try again.' });
    // The client wizard keys scores and the focus pillar by CAPITALIZED TP3 names
    // ('Trust'|'Proactivity'|'Productivity'). Emit that shape so the pillar card
    // auto-selects and the per-pillar diagnostic score badges render.
    const ms = parsed.scores || {};
    const tp3 = {
      Trust:        (scores.trust        != null ? scores.trust        : (ms.Trust        != null ? ms.Trust        : ms.trust)),
      Proactivity:  (scores.proactivity  != null ? scores.proactivity  : (ms.Proactivity  != null ? ms.Proactivity  : ms.proactivity)),
      Productivity: (scores.productivity != null ? scores.productivity : (ms.Productivity != null ? ms.Productivity : ms.productivity)),
    };
    parsed.scores = tp3;
    // Focus pillar: honor a valid model suggestion, else the lowest-scoring pillar.
    const VALID_PILLARS = ['Trust', 'Proactivity', 'Productivity'];
    let pillar = (parsed.suggested && VALID_PILLARS.indexOf(parsed.suggested.pillar) >= 0) ? parsed.suggested.pillar : null;
    if (!pillar) {
      const pairs = VALID_PILLARS.map(function (k) { return [k, tp3[k]]; }).filter(function (p) { return p[1] != null; });
      if (pairs.length) pillar = pairs.reduce(function (a, b) { return b[1] < a[1] ? b : a; })[0];
    }
    parsed.suggested.pillar = pillar || '';
    // Never invent people — the coach/leader add stakeholders in the wizard.
    parsed.suggested.stakeholders = [];
    if (!parsed.suggested.metric2 || typeof parsed.suggested.metric2 !== 'object') parsed.suggested.metric2 = { question: '', targetAvg: 4.0 };
    if (parsed.suggested.metric2.targetAvg == null) parsed.suggested.metric2.targetAvg = 4.0;
    parsed.source = 'coach-generated';
    parsed.generated_at = new Date().toISOString();
    return res.status(200).json({ ok: true, prefill: parsed });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-dr-content
// POST /api/diagnostic?action=generate-dr-content   Body: { team_id, session }
//
// Fills the Decision Room content layer for a team from its members' IN-SYSTEM
// diagnostic data: the team narrative (quick_read, summary, themes, start/stop/
// continue, intent-vs-impact) and each scored member's report_json (summaryLine,
// recommended 90-day focus, succession/bench, readiness level). The team snapshot
// TP3 is computed from data (not AI). This is what fills the previously-blank
// cards. The coach reviews/edits (quick_read + summary are editable) before
// sharing a sponsor link. Legacy/PDF-only leaders are handled separately.
// ═══════════════════════════════════════════════════════════════════════════════
const DR_CONTENT_SYSTEM = `You are an executive leadership assessment specialist for GPS Leadership Solutions, writing the internal "Decision Room" content a CEO/sponsor reads about a leadership team. You write for a skeptical, time-poor CEO: plain, direct, specific, no fluff or motivational language.

You will receive each scored leader's TP3 diagnostic results (Trust, Proactivity, Productivity on a 1-5 scale, raters vs self) and anonymized verbatim themes. Produce ONLY a single JSON object, no prose, no code fences, exactly this shape:

{
  "team": {
    "quick_read": "one tight sentence: the net of where this team stands",
    "summary": "2-4 sentences a CEO can read in 20 seconds",
    "themes": { "strengths": ["..."], "riskPatterns": ["..."] },
    "start_stop_continue": { "start": ["..."], "stop": ["..."], "continue": ["..."] },
    "intent_impact": [ { "intent": "what the team means to do", "impact": "how it actually lands" } ]
  },
  "members": [
    {
      "client_id": "<echo the id you were given>",
      "summaryLine": "one sentence on this leader's current standing",
      "focus": { "goal90": "a recommended 90-day development goal", "behaviors": ["specific behavior to practice", "..."] },
      "succession": { "successorIdentified": false, "readiness": "honest read on readiness for more scope", "benchNote": "one line on bench depth", "bench": [] },
      "readinessLevel": "ready | developing | not_ready"
    }
  ]
}

Rules: Base everything ONLY on the scores and verbatim themes provided. Do NOT invent specific people, names, numbers, or metrics. Leave "bench" an empty array unless the data clearly supports entries. Keep lists to 2-4 items. readinessLevel must be exactly "ready", "developing", or "not_ready". Use the GPS scale lens: 4.0+ is strong, 3.0-3.99 needs a plan, below 3.0 is a role-fit concern. Echo each client_id exactly as given.`;

function buildDRContentPrompt(team, scored) {
  const lines = [
    `TEAM: ${team.client_org_name || ''} — ${team.name || ''} (${team.team_type || 'team'})`,
    `Scored leaders: ${scored.length}`,
    '',
  ];
  for (const s of scored) {
    const o = s.scores || {};
    lines.push(`--- LEADER (client_id: ${s.client_id}) ---`);
    lines.push(`Name/role: ${s.name}${s.role ? ', ' + s.role : ''}`);
    lines.push(`TP3 (raters, 1-5): Trust ${fmtN(o.trustScore)} | Proactivity ${fmtN(o.proactivityScore)} | Productivity ${fmtN(o.productivityScore)} | TP3 index ${fmtN(o.tp3Index)}`);
    lines.push(`Self-rating (1-5):  Trust ${fmtN(s.self && s.self.trust)} | Proactivity ${fmtN(s.self && s.self.proactivity)} | Productivity ${fmtN(s.self && s.self.productivity)}`);
    if (o.benchScore != null) lines.push(`Bench/succession signal (F1-F2, 1-5): ${fmtN(o.benchScore)}`);
    const vb = s.verbatims || {};
    const vbKeys = Object.keys(vb);
    if (vbKeys.length) {
      lines.push('Verbatim themes (anonymized):');
      for (const k of vbKeys.slice(0, 8)) {
        const texts = (vb[k] || []).slice(0, 3).map(t => `"${String(t).slice(0, 160)}"`).join(' ');
        if (texts) lines.push(`  ${k}: ${texts}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
function fmtN(n) { return (n != null && !isNaN(n)) ? Number(n).toFixed(2) : 'n/a'; }

function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

async function handleGenerateDRContent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { team_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!team_id) return res.status(400).json({ error: 'team_id required' });

  try {
    const teamRows = await (await sb(`/rest/v1/teams?id=eq.${team_id}&select=*`)).json();
    const team = Array.isArray(teamRows) && teamRows[0];
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const members = await (await sb(`/rest/v1/team_members?team_id=eq.${team_id}&select=id,client_id,role`)).json();
    if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'No members on this team' });

    const cids = members.map(m => m.client_id).filter(Boolean);
    const clients = cids.length ? await (await sb(`/rest/v1/clients?id=in.(${cids.map(c => `"${c}"`).join(',')})&select=id,name,title`)).json() : [];
    const nameById = {}, titleById = {};
    (clients || []).forEach(c => { nameById[c.id] = c.name; titleById[c.id] = c.title; });

    const scored = [];
    const tA = [], tB = [], tC = [];
    let latestClose = null;

    for (const m of members) {
      const diags = await (await sb(`/rest/v1/diagnostics?client_id=eq.${enc4(m.client_id)}&status=in.("survey_closed","report_draft","report_final")&select=id,survey_closed_at&order=created_at.desc&limit=1`)).json();
      const diag = Array.isArray(diags) && diags[0];
      if (!diag) continue;
      if (diag.survey_closed_at && (!latestClose || diag.survey_closed_at > latestClose)) latestClose = diag.survey_closed_at;

      const raters = await (await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&select=id,is_self`)).json();
      const selfIds = new Set((raters || []).filter(r => r.is_self).map(r => r.id));
      const resp = await (await sb(`/rest/v1/diagnostic_responses?diagnostic_id=eq.${diag.id}&select=rater_id,question_code,score,text_response`)).json();
      const others = (resp || []).filter(r => !selfIds.has(r.rater_id));
      const selfR = (resp || []).filter(r => selfIds.has(r.rater_id));

      const scores = buildScoreSummary(others);
      const selfMap = {};
      selfR.forEach(r => { if (r.score != null) selfMap[r.question_code] = Number(r.score); });
      const self = {
        trust:        avg(['A1','A2','A3','A4','A5','A6','A7'].map(c => selfMap[c]).filter(s => s != null && !isNaN(s))),
        proactivity:  avg(['B1','B2','B3','B4','B5','B6'].map(c => selfMap[c]).filter(s => s != null && !isNaN(s))),
        productivity: avg(['C1','C2','C3','C4','C5','C6'].map(c => selfMap[c]).filter(s => s != null && !isNaN(s))),
      };
      if (scores.trustScore        != null) tA.push(scores.trustScore);
      if (scores.proactivityScore  != null) tB.push(scores.proactivityScore);
      if (scores.productivityScore != null) tC.push(scores.productivityScore);

      scored.push({ id: m.id, client_id: m.client_id, name: nameById[m.client_id] || 'Leader', role: m.role || titleById[m.client_id] || '', scores, self, verbatims: collectVerbatims(others) });
    }

    if (!scored.length) {
      return res.status(400).json({ error: 'No team member has a completed in-system diagnostic yet. Content generation runs from in-system diagnostic data; legacy or PDF-only leaders are added separately.' });
    }

    // Deterministic (temperature 0) for reliable JSON, generous token budget for
    // larger teams, and one automatic retry with a stricter instruction if the
    // first reply doesn't parse.
    const userPrompt = buildDRContentPrompt(team, scored);
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const sys = DR_CONTENT_SYSTEM + (attempt > 0 ? '\n\nIMPORTANT: Your previous reply could not be parsed. Return ONLY the raw JSON object — no prose, no markdown, no code fences.' : '');
      const raw = await callClaude(sys, userPrompt, 8192, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, temperature: 0 });
      const p = parseJsonLoose(raw);
      if (p && p.team) parsed = p;
    }
    if (!parsed) return res.status(502).json({ error: 'The model returned content that could not be parsed as JSON. Please try again.' });

    const now = new Date().toISOString();
    const snapshot = { surveyClosed: true, asOf: latestClose || null, tp3: { trust: { score: avg(tA) }, proactivity: { score: avg(tB) }, productivity: { score: avg(tC) } } };

    await sb(`/rest/v1/teams?id=eq.${team_id}`, 'PATCH', {
      quick_read:          parsed.team.quick_read || null,
      summary:             parsed.team.summary || null,
      themes:              parsed.team.themes || null,
      start_stop_continue: parsed.team.start_stop_continue || null,
      intent_impact:       parsed.team.intent_impact || null,
      snapshot:            snapshot,
      last_updated:        now,
      updated_at:          now,
    }, { Prefer: 'return=minimal' });

    const byClient = {};
    (parsed.members || []).forEach(mm => { if (mm.client_id) byClient[mm.client_id] = mm; });
    // Preserve coach-edited summary lines: if a member's summaryLine was locked by
    // the coach (drSaveMemberSummary), keep it instead of overwriting with the AI value.
    const existRows = await (await sb(`/rest/v1/team_members?team_id=eq.${team_id}&select=id,report_json`)).json();
    const existById = {};
    (Array.isArray(existRows) ? existRows : []).forEach(r => { existById[r.id] = (r.report_json && typeof r.report_json === 'object') ? r.report_json : {}; });
    for (const s of scored) {
      const mm = byClient[s.client_id] || {};
      const prior = existById[s.id] || {};
      const keepLine = !!(prior.summaryLine_locked && prior.summaryLine);
      const report_json = {
        name:           s.name,
        summaryLine:    keepLine ? prior.summaryLine : (mm.summaryLine || null),
        summaryLine_locked: keepLine,
        focus:          mm.focus || null,
        succession:     mm.succession || null,
        readinessLevel: mm.readinessLevel || 'developing',
      };
      await sb(`/rest/v1/team_members?id=eq.${s.id}`, 'PATCH', { report_json }, { Prefer: 'return=minimal' });
    }

    return res.status(200).json({ ok: true, scored: scored.length, team: parsed.team });
  } catch (err) {
    console.error('[diagnostic/generate-dr-content] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
function enc4(v) { return encodeURIComponent(String(v)); }

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: nudge-checkin
// POST /api/diagnostic?action=nudge-checkin   Body: { client_id, session, message? }
// Emails a coaching client a friendly check-in reminder with their portal link.
// (SMS is a separate path that needs an SMS provider — see handleNudgeCheckin note.)
// ═══════════════════════════════════════════════════════════════════════════════
function buildNudgeEmail({ first, link, message }) {
  const body = message
    ? message.split('\n').map(p => `<p style="color:#1B2A4A;font-size:15px;line-height:1.7;margin:0 0 12px;">${p}</p>`).join('')
    : `<p style="color:#1B2A4A;font-size:15px;line-height:1.7;margin:0 0 12px;">Hi ${first},</p>
       <p style="color:#1B2A4A;font-size:15px;line-height:1.7;margin:0 0 12px;">Quick nudge — your weekly check-in is still open. It only takes a couple of minutes and it keeps your 90-day plan moving.</p>`;
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
    <div style="background:#1A3D6E;padding:18px 26px;border-radius:8px 8px 0 0;">
      <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;">GPS Leadership Solutions</div>
      <div style="color:#fff;font-size:19px;font-weight:700;margin-top:3px;">Your weekly check-in</div>
    </div>
    <div style="background:#fff;padding:24px 26px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;">
      ${body}
      <div style="margin:22px 0 0;text-align:center;">
        <a href="${link}" style="background:#1A3D6E;color:#fff;text-decoration:none;padding:13px 30px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Open your portal &rarr;</a>
      </div>
      ${(() => { try { return require('./brand-link').pasteLink(link, 'center'); } catch (_) { return ''; } })()}
      <p style="font-size:12px;color:#888;text-align:center;margin:12px 0 0;">You can do it right from your phone. – Alex, GPS Leadership Solutions</p>
    </div>
  </div>`;
}

async function handleNudgeCheckin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { client_id, session, message } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  try {
    const rows = await (await sb(`/rest/v1/clients?id=eq.${client_id}&select=name,email,token,preferred_name`)).json();
    const c = Array.isArray(rows) && rows[0];
    if (!c) return res.status(404).json({ error: 'Client not found' });
    if (!c.email) return res.status(400).json({ error: 'No email on file for this client.' });
    const link = `${PORTAL_BASE}/client?token=${c.token}`;
    const first = String(c.preferred_name || c.name || 'there').split(' ')[0];
    await sendEmail({ to: c.email, subject: 'Quick reminder: your weekly check-in', html: buildNudgeEmail({ first, link, message }), emailType: 'checkin_nudge', recipientName: c.name });
    try { await sb(`/rest/v1/clients?id=eq.${client_id}`, 'PATCH', { last_checkin_reminder_at: new Date().toISOString() }, { Prefer: 'return=minimal' }); } catch (_) {}
    // SMS path (future): with an SMS provider configured (e.g. Twilio creds in env)
    // and the client's mobile + opt-in, also send a text with the same link here.
    return res.status(200).json({ ok: true, email_sent: true, to: c.email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-recommendations
// POST /api/diagnostic?action=generate-recommendations   Body: { team_id, session }
// Drafts 3-5 recommendations from the team's generated Decision Room content, as
// editable DRAFTS (not visible to the sponsor) the coach then adjusts/approves.
// ═══════════════════════════════════════════════════════════════════════════════
const REC_SYSTEM = `You are an executive leadership advisor for GPS Leadership Solutions, distilling a team's Decision Room content into the "action dashboard": 4-6 high-leverage recommendations for a CEO/sponsor.

WHAT GPS DELIVERS: executive coaching, team coaching, leadership workshops and retreats, the diagnostic and other assessments and 360 debriefs, calibrated feedback sessions, succession-mapping facilitation, and leadership/advisory consulting. GPS does NOT run formal HR/performance processes, compensation redesign, or legal actions.

GROUND TRUTH: If a GPS team report is provided (an attached PDF and/or report text below), treat IT as the AUTHORITATIVE interpretation — it reflects how GPS reads the data and operates — and ground your recommendations primarily in it; the Decision Room fields (summary, themes, Start/Stop/Continue, intent-vs-impact, per-leader reads) are supporting context. If no report is provided, synthesize from the Decision Room fields. Either way: never introduce a brand-new direction, never contradict the report or the data, never invent names that are not in the material.

REQUIRED COVERAGE — produce 4-6 recommendations that MUST include at least one of EACH band:
  - sprint_plan: a recommendation that is DIRECTLY tied to the leader's 90-day sprint plan (goal, focus, and metric provided below in the context). Reference the actual goal by name. Explain HOW the coaching sprint addresses the leadership gap the data reveals. This is always the first recommendation. If no 90-day plan exists yet, note that defining a sprint plan is the immediate next step.
  - bottom: a risk / role-fit move for sub-3.0 leaders. Frame as a MUTUAL role-fit decision (clarity for the org AND the leader), not "more coaching."
  - top: an ACCELERATOR that leverages the top 10-20% (TP3 + bench) as multipliers — e.g., have them co-lead the operating-rhythm meetings, each mentor 1-2 mid-tier leaders, and codify 3-5 of their habits into the leadership standard/onboarding. ALWAYS include at least one of these; include two if there are several strong performers.
  - middle: a DEVELOPMENT move for the 3.0-3.99 band (where coaching ROI is highest). Name the specific mid-band leaders and pair them with the named top performers as mentors.
  - system: an operating-model move — meeting/decision standards, the bench/succession system, communication habits, or calibrated feedback.

RULES:
  - Do NOT default coaching to the bottom tier. Coaching dollars prioritize the middle and top; the bottom only if explicitly salvageable, never for chronic role-fit.
  - When you reference "development resources/budget," tie it to specific middle/top names from the data.
  - Be behaviorally concrete: a clear deliverable and, where natural, a success measure. Owner is a ROLE, not a person's name. Keep the role-fit tone respectful.
  - Do NOT promise referrals or name external vendors.
  - SUCCESSION / READINESS GUARDRAIL: if a recommendation touches succession, promotion, bench depth, or readiness for a bigger role, append this exact sentence to its description: "This recommendation is based on perception data from the diagnostic and should be combined with recent performance results, role requirements, and HR guidance before final succession or promotion decisions are made."

For EACH recommendation output these fields:
  - short_title: short, action-oriented imperative.
  - description: 2-4 plain sentences — what to do, the change it drives, and the concrete deliverable; behavior-focused and tied to the data.
  - category: "included_in_current_scope" or "optional_accelerator".
  - target_band: one or more of sprint_plan|top|middle|bottom|system, comma-separated if more than one (e.g. "top,middle"). The sprint_plan recommendation must use "sprint_plan" as the band.
  - gps_support_type: one of core_service (GPS directly delivers) | co_led (GPS designs/facilitates, client executes ongoing) | client_owned (client runs it; GPS provides framing/templates only) | outside_scope (important but outside GPS's services).
  - quick_start_today: ONE tiny action the leader can take by end of today (schedule a meeting, send an email, choose owners, jot names).
  - quick_start_week: ONE small, concrete step by end of this week (draft a 1-pager, run a 30-minute huddle, build a candidate list).
  - source_section: comma-separated tags of what this derives from, drawn ONLY from this set: team_summary, themes, start_stop_continue, intent_impact, member_reads.

Output ONLY a JSON object, no prose, no markdown, no code fences:
{ "recommendations": [ { "short_title": "", "description": "", "category": "included_in_current_scope", "target_band": "", "gps_support_type": "", "quick_start_today": "", "quick_start_week": "", "owner": "", "timeframe": "", "source_section": "" } ] }`;

async function handleGenerateRecommendations(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { team_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!team_id) return res.status(400).json({ error: 'team_id required' });
  try {
    const teamRows = await (await sb(`/rest/v1/teams?id=eq.${team_id}&select=*`)).json();
    const team = Array.isArray(teamRows) && teamRows[0];
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const members = await (await sb(`/rest/v1/team_members?team_id=eq.${team_id}&select=report_json,client_id`)).json();
    const memberLines = (Array.isArray(members) ? members : []).map(m => {
      const rj = m.report_json || {};
      return rj.summaryLine ? `- ${rj.name || 'Leader'}: ${rj.summaryLine}` : '';
    }).filter(Boolean);

    // Fetch 90-day sprint plan data for each member so the recommendation AI can
    // reference the actual plan the leader is working toward.
    const clientIds = (Array.isArray(members) ? members : []).map(m => m.client_id).filter(Boolean);
    let planLines = [];
    if (clientIds.length) {
      try {
        const clientRows = await (await sb(`/rest/v1/clients?id=in.(${clientIds.join(',')})&select=id,name,plan_goal_90,plan_goal_30,metric_1_name,metric_1_target,metric_1_type,metric_1_ratio_denom`)).json();
        planLines = (Array.isArray(clientRows) ? clientRows : []).map(c => {
          if (!c.plan_goal_90 && !c.plan_goal_30) return null;
          const metricStr = c.metric_1_name
            ? ` | Success metric: ${c.metric_1_name}${c.metric_1_target != null ? ` → target ${c.metric_1_type === 'ratio' ? `${c.metric_1_target}/${c.metric_1_ratio_denom}` : c.metric_1_target}` : ''}`
            : '';
          return `- ${c.name || 'Leader'}: 90-day goal: ${c.plan_goal_90 || '(not set)'}${c.plan_goal_30 ? ` | 30-day focus: ${c.plan_goal_30}` : ''}${metricStr}`;
        }).filter(Boolean);
      } catch (_) { /* non-fatal — plan data is enrichment, not required */ }
    }

    // The coach-uploaded branded report PDF is the authoritative interpretation;
    // its generated draft text is the fallback. Recommendations ground in the report.
    const repRows = await (await sb(`/rest/v1/diagnostic_team_reports?team_id=eq.${team_id}&select=report_pdf_url,content_text,generated_at&order=generated_at.desc&limit=1`)).json();
    const rep = Array.isArray(repRows) && repRows[0];
    const hasDR = !!(team.summary || team.themes);
    const hasReport = !!(rep && (rep.report_pdf_url || rep.content_text));
    if (!hasDR && !hasReport) {
      return res.status(400).json({ error: 'Generate the Decision Room content (Narrative panel) or upload a team report first, then draft recommendations.' });
    }

    let pdfBase64 = null;
    if (rep && rep.report_pdf_url) {
      try {
        const pres = await fetch(rep.report_pdf_url);
        if (pres.ok) {
          const ab = await pres.arrayBuffer();
          if (ab && ab.byteLength > 0 && ab.byteLength < 28 * 1024 * 1024) pdfBase64 = Buffer.from(ab).toString('base64');
        }
      } catch (_) { pdfBase64 = null; }
    }

    const drBlock = [
      `TEAM: ${team.client_org_name || ''} — ${team.name || ''}`,
      `Quick read: ${team.quick_read || ''}`,
      `Summary: ${team.summary || ''}`,
      `Themes: ${JSON.stringify(team.themes || {})}`,
      `Start/Stop/Continue: ${JSON.stringify(team.start_stop_continue || {})}`,
      `Intent vs Impact: ${JSON.stringify(team.intent_impact || [])}`,
      'Leaders:', ...memberLines,
      ...(planLines.length ? ['\n90-DAY SPRINT PLANS (reference these for the sprint_plan recommendation):', ...planLines] : ['\n90-DAY SPRINT PLANS: No plans set yet — recommend defining one as the immediate next step.']),
    ].join('\n');
    const reportTextBlock = (!pdfBase64 && rep && rep.content_text)
      ? `\n\n=== GPS TEAM REPORT (authoritative interpretation) ===\n${rep.content_text}`
      : '';
    const attachNote = pdfBase64 ? 'The attached PDF is the authoritative GPS team report. Ground your recommendations in it; the Decision Room content below is supporting context.\n\n' : '';
    const input = attachNote + '=== DECISION ROOM CONTENT (supporting context) ===\n' + drBlock + reportTextBlock;

    // Try with the PDF attached; if it errors or doesn't parse, retry text-only.
    let parsed = null;
    try { parsed = parseJsonLoose(await callClaude(REC_SYSTEM, input, 3072, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, temperature: 0, documentBase64: pdfBase64 })); } catch (_) { parsed = null; }
    if ((!parsed || !Array.isArray(parsed.recommendations)) && pdfBase64) {
      try { parsed = parseJsonLoose(await callClaude(REC_SYSTEM, input, 3072, { model: CLAUDE_REPORT_MODEL, timeoutMs: 100000, temperature: 0 })); } catch (_) { parsed = null; }
    }
    const recs = parsed && Array.isArray(parsed.recommendations) ? parsed.recommendations : null;
    if (!recs) return res.status(502).json({ error: 'Could not parse recommendations. Please try again.' });

    const now = new Date().toISOString();
    let inserted = 0;
    for (const r of recs.slice(0, 6)) {
      if (!r || !r.short_title) continue;
      const allowedBands = ['top','middle','bottom','system'];
      const bands = String(r.target_band || '').split(',').map(s => s.trim().toLowerCase()).filter(b => allowedBands.includes(b));
      const allowedFit = ['core_service','co_led','client_owned','outside_scope'];
      const fit = allowedFit.includes(r.gps_support_type) ? r.gps_support_type : null;
      await sb('/rest/v1/recommendations', 'POST', {
        team_id,
        short_title:  String(r.short_title).slice(0, 200),
        description:  String(r.description || '').slice(0, 2000),
        category:     (r.category === 'optional_accelerator' ? 'optional_accelerator' : 'included_in_current_scope'),
        owner:        r.owner ? String(r.owner).slice(0, 120) : null,
        timeframe:    r.timeframe ? String(r.timeframe).slice(0, 80) : null,
        target_band:       bands.length ? bands.join(',') : null,
        gps_support_type:  fit,
        quick_start_today: r.quick_start_today ? String(r.quick_start_today).slice(0, 400) : null,
        quick_start_week:  r.quick_start_week ? String(r.quick_start_week).slice(0, 400) : null,
        source_section:    r.source_section ? String(r.source_section).slice(0, 200) : null,
        status:       'draft',
        visible_to_client: false,
        created_at:   now,
        updated_at:   now,
      }, { Prefer: 'return=minimal' });
      inserted++;
    }
    return res.status(200).json({ ok: true, inserted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS: ad-hoc external feedback (coach requests → emailed link → observation
// lands as an external_signal the coach approves before the sponsor sees it).
// ═══════════════════════════════════════════════════════════════════════════════
function buildExternalFeedbackEmail({ name, teamName, link }) {
  const first = (name || '').split(' ')[0] || 'there';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
    <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
      <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;">A quick request for your input</div>
    </div>
    <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
      <p>Hi ${first},</p>
      <p>As part of our work with the <strong>${teamName}</strong> leadership team, I'd value a short, candid observation from you. It takes about two minutes.</p>
      <div style="margin:26px 0 0;text-align:center;">
        <a href="${link}" style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;">Share your input →</a>
      </div>
      ${(() => { try { return require('./brand-link').pasteLink(link, 'center'); } catch (_) { return ''; } })()}
      <p style="font-size:13px;color:#666;margin:12px 0 0;">This link is unique to you. – Alex Tremble, GPS Leadership Solutions</p>
    </div>
  </div>`;
}

async function handleRequestExternalFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { team_id, name, email, by_role, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!team_id || !name || !email) return res.status(400).json({ error: 'team_id, name, and email are required' });
  try {
    const teamRows = await (await sb(`/rest/v1/teams?id=eq.${team_id}&select=name,client_org_name`)).json();
    const team = Array.isArray(teamRows) && teamRows[0];
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const token = crypto.randomUUID().replace(/-/g, '');
    await sb('/rest/v1/external_feedback_invites', 'POST', { token, team_id, name, email, by_role: by_role || null }, { Prefer: 'return=minimal' });
    const link = `${PORTAL_BASE}/feedback?token=${token}`;
    let emailSent = false;
    try {
      await sendEmail({ to: email, subject: `A quick request for your input — ${team.client_org_name || team.name} leadership team`, html: buildExternalFeedbackEmail({ name, teamName: team.client_org_name || team.name, link }), emailType: 'external_feedback_invite', recipientName: name });
      emailSent = true;
    } catch (_) {}
    return res.status(200).json({ ok: true, link, email_sent: emailSent });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleFeedbackContext(req, res) {
  const token = req.body?.token || req.query?.token;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const rows = await (await sb(`/rest/v1/external_feedback_invites?token=eq.${enc4(token)}&select=name,by_role,submitted_at,team_id`)).json();
    const inv = Array.isArray(rows) && rows[0];
    if (!inv) return res.status(404).json({ error: 'This link is invalid or has expired.' });
    const teamRows = await (await sb(`/rest/v1/teams?id=eq.${inv.team_id}&select=name,client_org_name`)).json();
    const team = (Array.isArray(teamRows) && teamRows[0]) || {};
    return res.status(200).json({ ok: true, name: inv.name, by_role: inv.by_role || '', team_name: team.client_org_name || team.name || 'the leadership team', submitted: !!inv.submitted_at, submitted_at: inv.submitted_at || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleSubmitExternalFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, summary, level, name, by_role } = req.body || {};
  if (!token || !summary || !String(summary).trim()) return res.status(400).json({ error: 'token and a written observation are required' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Your name is required.' });
  if (!by_role || !String(by_role).trim()) return res.status(400).json({ error: 'Your role is required.' });
  const lv = ['green', 'yellow', 'red'].includes(level) ? level : 'yellow';
  try {
    const rows = await (await sb(`/rest/v1/external_feedback_invites?token=eq.${enc4(token)}&select=id,team_id,name,by_role,submitted_at`)).json();
    const inv = Array.isArray(rows) && rows[0];
    if (!inv) return res.status(404).json({ error: 'This link is invalid or has expired.' });
    if (inv.submitted_at) return res.status(409).json({ error: 'This feedback has already been submitted. Thank you.' });
    await sb('/rest/v1/external_signals', 'POST', {
      // The respondent self-identifies on the form; prefer those over invite values.
      team_id: inv.team_id, by_name: String(name).trim().slice(0, 120), by_role: String(by_role).trim().slice(0, 120),
      channel: 'External feedback', level: lv, summary: String(summary).slice(0, 2000),
      date_observed: new Date().toISOString().slice(0, 10), visible_to_client: false,
    }, { Prefer: 'return=minimal' });
    await sb(`/rest/v1/external_feedback_invites?id=eq.${inv.id}`, 'PATCH', { submitted_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// A survey should never close on a Saturday or Sunday. Given a 'YYYY-MM-DD' close
// date, roll a weekend date forward to the following Monday. Weekdays pass through
// unchanged. Uses UTC so it matches how close dates are stored and compared.
function rollCloseOffWeekend(iso) {
  if (!iso) return iso;
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

async function handleReminders(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron    = req.headers['x-vercel-cron'] === '1';
  const isManualTrigger = req.method === 'POST' && !!verifyCoachSession(req.body?.session);
  const authHeader      = req.headers['authorization'] || '';
  const hasSecret       = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualTrigger && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = { r1_sent: [], r2_sent: [], t2_alerts: [], all_complete_alerts: [], plans_locked: [], delivery_alert: null, errors: [] };
  const now = new Date();

  try {
    // ── Section 1: Rater Reminders (R1 + R2) ────────────────────────────────
    const openDiagsRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&select=id,client_name,client_email,close_date,anonymous_feedback,cc_leader_first_reminder,suppress_auto_reminders`);
    const openDiags    = await openDiagsRes.json() || [];

    // Weekend-close guard (runs daily): no survey should close on a Sat/Sun. Roll any
    // open diagnostic whose close date landed on a weekend forward to the Monday, and
    // persist it so the survey page, emails, and reminder cadence all agree.
    for (const diag of openDiags) {
      if (!diag.close_date) continue;
      const rolled = rollCloseOffWeekend(diag.close_date);
      if (rolled !== diag.close_date) {
        try { await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH', { close_date: rolled }, { Prefer: 'return=minimal' }); } catch (_) {}
        diag.close_date = rolled;
      }
    }

    // Editable templates (only used when coach has approved them; otherwise hardcoded copy stands)
    const r1Tpl = await getApprovedTemplate('diagnostic_reminder_1');
    const r2Tpl = await getApprovedTemplate('diagnostic_reminder_2');

    for (const diag of openDiags) {
      // Skip per-leader rater reminders when this diagnostic is handled by the
      // consolidated peer-feedback nudge instead (one email per rater, not per leader).
      if (diag.suppress_auto_reminders) continue;
      const ratersRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&completed_at=is.null&invited_at=not.is.null&select=id,name,email,token,invited_at,reminder_1_sent_at,reminder_2_sent_at,email_bounced`
      );
      const raters = await ratersRes.json() || [];

      for (const rater of raters) {
        if (rater.email_bounced) continue;
        const daysSinceInvite = daysBetween(new Date(rater.invited_at), now);
        const surveyLink = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;

        const _ccCfg = await loadCcConfig();
        const reminderCc1 = buildDiagCc(_ccCfg, diag, 'reminder_1');  // leader CC'd only if diag is flagged
        const reminderCc2 = buildDiagCc(_ccCfg, diag, 'reminder_2');  // never copies the leader
        const daysToClose = diag.close_date ? daysFromNow(diag.close_date) : 999;

        const closeFmt = diag.close_date
          ? new Date(diag.close_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : 'soon';
        const firstName = (rater.name || '').split(' ')[0] || 'there';

        // Reminder 1 — mid-window nudge, ~3 days before close. Leader CC'd only if flagged.
        if (daysToClose <= 3.5 && daysToClose >= 0.5 && !rater.reminder_1_sent_at) {
          let bodyHtml = null, subjectOverride = null;
          if (r1Tpl) {
            const vars = { first_name: firstName, rater_name: rater.name, leader_name: diag.client_name, close_date: closeFmt, survey_link: surveyLink };
            if (r1Tpl.subject) subjectOverride = fillTemplate(r1Tpl.subject, vars) || null;
            if (r1Tpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(r1Tpl.body_text, vars));
          }
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: false, bodyHtml, subjectOverride });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_1', recipientName: rater.name, cc: reminderCc1 });
            await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { reminder_1_sent_at: now.toISOString() }, { Prefer: 'return=minimal' });
            log.r1_sent.push({ name: rater.name, diag: diag.client_name });
          } catch (err) {
            log.errors.push({ type: 'R1', name: rater.name, error: err.message });
          }
          continue;
        }

        // Reminder 2 — final nudge the morning the survey closes. Never copies the leader.
        if (daysToClose < 0.5 && !rater.reminder_2_sent_at) {
          let bodyHtml = null, subjectOverride = null;
          if (r2Tpl) {
            const vars = { first_name: firstName, rater_name: rater.name, leader_name: diag.client_name, close_date: closeFmt, survey_link: surveyLink };
            if (r2Tpl.subject) subjectOverride = fillTemplate(r2Tpl.subject, vars) || null;
            if (r2Tpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(r2Tpl.body_text, vars));
          }
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: true, bodyHtml, subjectOverride });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_2', recipientName: rater.name, cc: reminderCc2 });
            await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { reminder_2_sent_at: now.toISOString() }, { Prefer: 'return=minimal' });
            log.r2_sent.push({ name: rater.name, diag: diag.client_name });
          } catch (err) {
            log.errors.push({ type: 'R2', name: rater.name, error: err.message });
          }
        }
      }
    }

    // ── Section 2: T-2 Alerts ────────────────────────────────────────────────
    const t2DiagsRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&alert_t2_sent_at=is.null&select=id,client_name,close_date`);
    const t2Diags    = await t2DiagsRes.json() || [];

    for (const diag of t2Diags) {
      if (!diag.close_date) continue;
      const daysToClose = daysFromNow(diag.close_date);
      if (daysToClose < 1.5 || daysToClose > 2.5) continue;

      const countRes   = await sb(`/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&select=id,completed_at`);
      const allRaters  = await countRes.json() || [];
      const completedCount = allRaters.filter(r => r.completed_at).length;
      const totalInvited   = allRaters.length;

      if (completedCount >= 7) continue;

      const email = buildT2AlertEmail({ leaderName: diag.client_name, closeDate: diag.close_date, completedCount, totalInvited });
      try {
        await sendEmail({ to: COACH_EMAIL, ...email, emailType: 'diagnostic_t2_alert' });
        await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH', { alert_t2_sent_at: now.toISOString(), updated_at: now.toISOString() }, { Prefer: 'return=minimal' });
        log.t2_alerts.push({ diag: diag.client_name, completedCount, totalInvited });
      } catch (err) {
        log.errors.push({ type: 'T2_ALERT', diag: diag.client_name, error: err.message });
      }
    }

    // ── Section 3: 90-Day Plan Auto-Lock ─────────────────────────────────────
    const debriefDiagsRes = await sb(`/rest/v1/diagnostics?plan_status=eq.active&plan_locked_at=is.null&debrief_completed_at=not.is.null&select=id,client_name,debrief_completed_at`);
    const debriefDiags    = await debriefDiagsRes.json() || [];

    for (const diag of debriefDiags) {
      const hoursSinceDebrief = daysBetween(new Date(diag.debrief_completed_at), now) * 24;
      if (hoursSinceDebrief < 24) continue;

      const lockedAt = now.toISOString();
      try {
        await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH',
          { plan_status: 'locked', plan_locked_at: lockedAt, plan_lock_source: 'auto_24h', updated_at: lockedAt },
          { Prefer: 'return=minimal' }
        );
        const email = buildPlanLockedEmail({ leaderName: diag.client_name, lockedAt });
        await sendEmail({ to: COACH_EMAIL, ...email, emailType: 'diagnostic_plan_locked' });
        log.plans_locked.push({ diag: diag.client_name, locked_at: lockedAt });
      } catch (err) {
        log.errors.push({ type: 'AUTO_LOCK', diag: diag.client_name, error: err.message });
      }
    }

    // ── Section 4: Email Delivery Health Check ──────────────────────────────────
    try {
      const twoHoursAgo  = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

      // Don't alert if we already sent one in the last 4 hours
      const alertCheckRes = await sb(`/rest/v1/email_log?email_type=eq.email_delivery_alert&sent_at=gte.${fourHoursAgo}&select=id`);
      const recentAlerts  = await alertCheckRes.json() || [];

      if (recentAlerts.length === 0) {
        const recentLogsRes = await sb(`/rest/v1/email_log?sent_at=gte.${twoHoursAgo}&select=status,email_type,error_details,recipient_email`);
        const recentLogs    = await recentLogsRes.json() || [];

        if (recentLogs.length >= 3) {
          const errors    = recentLogs.filter(l => l.status === 'error');
          const successes = recentLogs.filter(l => l.status === 'sent');

          if (errors.length >= 3 && errors.length > successes.length) {
            const errSummary = errors.slice(0, 5)
              .map(e => `• ${e.email_type} → ${e.recipient_email}: ${e.error_details ? JSON.parse(e.error_details)?.message || e.error_details : 'unknown'}`)
              .join('\n');
            const alertEmail = buildDeliveryAlertEmail({ errorCount: errors.length, totalCount: recentLogs.length, errSummary });
            await sendEmail({ to: COACH_EMAIL, ...alertEmail, emailType: 'email_delivery_alert' });
            log.delivery_alert = { errors: errors.length, total: recentLogs.length };
          }
        }
      }
    } catch (alertErr) {
      log.errors.push({ type: 'DELIVERY_HEALTH_CHECK', error: alertErr.message });
    }

    // ── Section 5: Portal Engagement Nudge ─────────────────────────────────────
    // Find active diagnostic clients who haven't logged in for 7+ days
    try {
      const sevenDaysAgo     = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString();
      const fourteenDaysAgo  = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

      // Get client_ids from diagnostics that are still active (not done, not archived)
      const activeDiagRes = await sb(
        `/rest/v1/diagnostics?status=not.in.(debrief_complete,plan_active,cancelled)&client_id=not.is.null&select=client_id`
      );
      const activeDiags   = await activeDiagRes.json() || [];
      const activeCids    = [...new Set(activeDiags.map(d => d.client_id))];

      if (activeCids.length > 0) {
        // Fetch those clients who haven't been active in 7+ days
        const cidFilter = activeCids.map(id => `"${id}"`).join(',');
        const staleRes  = await sb(
          `/rest/v1/clients?id=in.(${cidFilter})&is_archived=eq.false&last_active_at=lt.${encodeURIComponent(sevenDaysAgo)}&select=id,name,email,org,token,last_active_at`
        );
        const staleClients = await staleRes.json() || [];

        for (const client of staleClients) {
          if (!client.token) continue; // no portal link — can't send

          // Check for recent nudge (last 14 days) to avoid spam
          const nudgeCheckRes = await sb(
            `/rest/v1/email_log?email_type=eq.portal_engagement_nudge&recipient_email=eq.${encodeURIComponent(client.email)}&sent_at=gte.${encodeURIComponent(fourteenDaysAgo)}&select=id`
          );
          const recentNudges = await nudgeCheckRes.json() || [];
          if (recentNudges.length > 0) continue;

          const daysSince  = Math.round((now - new Date(client.last_active_at)) / (1000 * 60 * 60 * 24));
          const portalUrl  = `${PORTAL_BASE}/client?token=${client.token}`;
          const nudgeEmail = buildPortalNudgeEmail({
            clientName: client.name,
            leaderOrg:  client.org || null,
            portalUrl,
            daysSince,
          });

          try {
            await sendEmail({
              to:            client.email,
              ...nudgeEmail,
              emailType:     'portal_engagement_nudge',
              recipientName: client.name,
            });
            log.portal_nudges = (log.portal_nudges || 0) + 1;
          } catch (nudgeErr) {
            log.errors.push({ type: 'PORTAL_NUDGE', client: client.name, error: nudgeErr.message });
          }
        }
      }
    } catch (nudgeErr) {
      log.errors.push({ type: 'PORTAL_NUDGE_SECTION', error: nudgeErr.message });
    }

    // ── Section 6: All-Raters-Complete Alert ───────────────────────────────────
    // When every non-self rater has responded, alert Alex once.
    try {
      const openForCompleteRes = await sb(
        `/rest/v1/diagnostics?status=eq.survey_open&all_raters_complete_at=is.null&select=id,client_name,close_date`
      );
      const openForComplete = await openForCompleteRes.json() || [];

      for (const diag of openForComplete) {
        const ratersRes = await sb(
          `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&select=id,name,completed_at`
        );
        const raters = await ratersRes.json() || [];
        if (raters.length < 7) continue;  // minimum 7 responses required for a valid report
        const all = raters.every(r => r.completed_at);
        if (!all) continue;

        const completedCount = raters.length;
        const email = buildAllCompleteEmail({ leaderName: diag.client_name, completedCount, closeDate: diag.close_date });
        try {
          await sendEmail({ to: COACH_EMAIL, ...email, emailType: 'diagnostic_all_complete' });
          await sb(`/rest/v1/diagnostics?id=eq.${diag.id}`, 'PATCH',
            { all_raters_complete_at: now.toISOString(), updated_at: now.toISOString() },
            { Prefer: 'return=minimal' }
          );
          log.all_complete_alerts.push({ diag: diag.client_name, count: completedCount });
        } catch (err) {
          log.errors.push({ type: 'ALL_COMPLETE_ALERT', diag: diag.client_name, error: err.message });
        }
      }
    } catch (err) {
      log.errors.push({ type: 'ALL_COMPLETE_SECTION', error: err.message });
    }

    await recordHeartbeat('diagnostic-reminders', 'ok', `r1 ${log.r1_sent.length}, r2 ${log.r2_sent.length}`);
    return res.status(200).json({
      ran_at:               now.toISOString(),
      r1_sent:              log.r1_sent.length,
      r2_sent:              log.r2_sent.length,
      t2_alerts:            log.t2_alerts.length,
      all_complete_alerts:  log.all_complete_alerts.length,
      plans_locked:         log.plans_locked.length,
      portal_nudges:        log.portal_nudges || 0,
      delivery_alert:       log.delivery_alert,
      details:              log,
    });


  } catch (err) {
    console.error('[diagnostic/reminders] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: generate-team-report
// POST /api/diagnostic?action=generate-team-report
// Body: { diagnostic_ids[], org_name, team_name, prepared_for_name,
//         prepared_for_title, assessment_date_range, sector_type }
// ═══════════════════════════════════════════════════════════════════════════════

const TEAM_REPORT_SYSTEM_PROMPT = `You are the GPS Leadership Solutions Team Report Generator. You produce DRAFT composite leadership reports for internal consultant review ONLY. A human consultant (Alex D. Tremble) will review, edit, and finalize before any client sees the report.

CRITICAL: Every report must begin with this exact header block:
STATUS: DRAFT – INTERNAL USE ONLY (FOR CONSULTANT REVIEW, NOT FOR DIRECT CLIENT DISTRIBUTION)
Prepared for: [REPLACE with prepared_for_name and prepared_for_title from input]
Organization: [REPLACE with org_name]
Team: [REPLACE with team_name]
Prepared by: Alex D. Tremble, Founder & CEO, GPS Leadership Solutions
Assessment window: [REPLACE with assessment_date_range]

SECTOR / LANGUAGE MODE
If sector_type is "government_federal" or "government_state_local":
  - Use: "agency head," "director," "secretary," "mission outcomes," "public trust," "communities served," "taxpayers," "oversight bodies," "service quality," "stewardship"
  - Avoid: "CEO," "customers," "profit," "shareholders," "margin"
  - Frame outcomes as: mission execution, compliance, service quality, public impact
If sector_type is anything else (private sector default):
  - Use: "CEO," "executive team," "customers," "profitability," "margin," "board," "owners"
  - Frame outcomes as: growth, execution speed, customer impact, profitability

TONE & PRIVACY RULES
- Audience: C-suite executives or senior agency officials — intelligent, time-limited, skeptical of fluff
- Tone: concise, direct, calm, behavior-focused. No filler sentences.
- Never reproduce verbatim quotes. Paraphrase as: "Several raters noted that…" or "Across multiple assessments, raters observed…"
- Never shame or negatively name a specific leader. Use "some leaders," "a subset of the team," or "the team" for sensitive patterns
- Treat this as developmental, not punitive
- Write in flowing prose with clear section breaks. Use markdown headers (## and ###) and bullet points (-) where appropriate.

SUCCESSION / READINESS GUARDRAIL
Anywhere this report discusses succession, bench depth, promotion readiness, or readiness for a larger role (including in the heat analysis, the playbook, and the appendix), include 2–3 sentences making clear that: this signal comes from perception data in the diagnostic and is real, useful input; it is not a complete picture on its own; and it should be combined with recent performance results, the requirements of the next role, and HR or risk guidance before any promotion or succession decision. Frame it as "the chart informs the decision; the leaders accountable for the business make it." Do not soften this into a throwaway line — state it plainly.

REQUIRED SECTION ORDER:

## 1. Cover & Context
Restate: organization, team, assessment window, number of leaders, total raters. Clarify this is a composite view based on the 14-Day Executive Leadership Diagnostic. Note that this is perception data — most useful for identifying patterns and driving conversations, not grades.

## 2. Executive Summary — If You Read One Page, Read This

### A. Key Team Strengths
3 bullets: biggest, most consistent team strengths expressed as concrete, observable behaviors.

### B. Key Risk Areas / Bottlenecks
3 bullets: most important team-level risk patterns. Be direct.

### C. High-Leverage 90-Day Team Moves
3 bullets: the three highest-impact actions the team could take in 90 days.

### D. Key Decisions This Report Is Asking You to Make (Next 90 Days)
3 bullets phrased as decisions. Examples (adapt to sector/data):
- "Will we standardize how our leadership meetings run and what 'decision-ready' looks like?"
- "Will we clarify and enforce a shared definition of ownership for direct reports?"
Keep this entire section under 350 words and highly scannable.

## 3. Team Heat Analysis — Strengths & Risk Areas
Where do average others scores cluster high across the team? Where are scores weak, uneven, or volatile?
- Flag dimensions with consistently lower others scores
- Flag dimensions with large self vs others gaps across multiple leaders (indicates blind spots)
- Flag dimensions with high volatility (some leaders much higher/lower than peers)
- Link to behavior: e.g., "High trust, low delegation: leaders are well-liked but still holding too many decisions."

## 4. Operating Consequences — What This Likely Looks Like Day-to-Day
Translate score patterns into what senior leaders probably observe in:
- Meetings (status vs decisions, conflict avoidance, uneven participation)
- Decision-making (escalation, slow approvals, re-litigation)
- Execution (unclear ownership, slow follow-through, cross-functional friction)
Use sector-appropriate language throughout.

## 5. Team Behavior Themes
Common positive behavioral themes across many leaders (e.g., approachable, technically strong, mission-driven).
Common developmental themes (e.g., avoids hard conversations, delegates tasks instead of outcomes, over-explains rather than decides).
Always speak at the team level — never single out an individual.

## 6. 90-Day Team Playbook — 3 to 5 Concrete Moves
For each move:
- Short title (imperative phrase, e.g., "Install a decision-centric leadership meeting cadence")
- Expected observable behavior changes
- Typical owner (e.g., CEO, COO, CHRO, full leadership team)
- 90-day success signal: "In 90 days, you would see…"
All moves must tie directly to patterns in the data and be achievable within 90 days.

## 7. Twelve-to-Twenty-Four-Month Trajectory: If We Change vs If We Don't
Two short paragraphs:
- "If current patterns mostly continue…": one paragraph on likely impact on execution, people, and outcomes
- "If the 90-day plays are executed consistently…": one paragraph on what would be noticeably different for staff, stakeholders, and the senior leader's calendar

## 8. Leadership Team Conversation Guide
5 to 7 tailored discussion questions for the team. Questions must:
- Start from strengths
- Surface ownership ("Where do you see yourself in these themes?")
- Focus on 1–2 priorities, not everything at once
- Use sector-appropriate language

[COACHING RECOMMENDATION SECTION — see rules below — insert here if warranted]

## 9. Appendix — Reading the Scores
Brief reference: define Trust, Proactivity, Productivity, TP3 Index, Overall Impact, and Bench Score. Explain the 1–5 scale and what each range means in behavioral terms. Use sector-appropriate language.

────────────────────────────────────────────────────────────────────────────────
COACHING & SUPPORT RECOMMENDATION LAYER
After generating sections 1–9, review the patterns you identified:
- Low or uneven scores across multiple core dimensions
- Large self vs others gaps (blind spots) across multiple leaders
- Recurring themes: avoidance of difficult conversations, delegation/ownership breakdowns, trust issues, cross-functional friction, slow execution
- 90-day plays that require sustained behavior change, not just process tweaks

If you judge that targeted coaching or team coaching would materially:
(a) accelerate progress on the 90-day plays, AND/OR
(b) reduce the risk of this report becoming "shelfware" —
THEN insert a section between sections 8 and 9 titled:
  - For non-government: "## Where Targeted Coaching Could Accelerate Results"
  - For government: "## Where Targeted Leadership Support Could Accelerate Mission Results"

SECTION CONTENT:
1. Open with 1–2 sentences: acknowledge that some themes require behavior change, not just new processes. Frame coaching as support for the leader(s), not as criticism.
2. Include 3–5 bullets: each connecting a specific report pattern to a type of coaching support. Examples:
   - "Executive coaching focused on delegation and ownership for leaders who are still centralizing key decisions."
   - "Team coaching to raise the quality of senior-level conversations and decision-making in recurring leadership meetings."
   - "Targeted 1:1 coaching for leaders with significant self vs others gaps, to translate feedback into concrete behavior shifts."
3. Close with a single, low-pressure next step sentence.

GUARDRAILS for this section:
- Do NOT make it a sales pitch. No pricing, packages, or performance guarantees.
- Do NOT say "you must" or "you should hire GPS Leadership Solutions."
- Every bullet must connect directly to a specific pattern from the report.
- Keep this section to 120–200 words maximum.
────────────────────────────────────────────────────────────────────────────────`;

function buildTeamReportPrompt({ org_name, team_name, prepared_for_name, prepared_for_title, assessment_date_range, sector_type, leaders, total_raters, verbatims, roster }) {
  const rosterList = Array.isArray(roster) ? roster : [];
  const fmt  = (n) => n != null ? n.toFixed(2) : 'n/a';
  const gap  = (self, others) => {
    if (self == null || others == null) return 'n/a';
    const d = others - self;
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
  };

  const lines = [
    `ORGANIZATION: ${org_name || 'Not specified'}`,
    `TEAM: ${team_name || 'Not specified'}`,
    `PREPARED FOR: ${prepared_for_name || 'Not specified'}${prepared_for_title ? `, ${prepared_for_title}` : ''}`,
    `ASSESSMENT WINDOW: ${assessment_date_range || 'Not specified'}`,
    `SECTOR TYPE: ${sector_type || 'private'}`,
    '',
    '=== TEAM COMPOSITION ===',
    `Leaders assessed: ${leaders.length}`,
    `Total raters (others only, completed): ${total_raters}`,
    '',
    '=== INDIVIDUAL LEADER SCORES ===',
  ];

  if (leaders.length === 1) {
    lines.splice(6, 0,
      'NOTE: Only ONE leader was assessed. Write this as a leadership assessment for this single leader, not a cross-leader comparison. Do not refer to "the team," "other leaders," "across leaders," or imply that multiple people were assessed. Focus the recommendations on this individual and on the organizational system around them.'
    );
  }

  for (const l of leaders) {
    lines.push('');
    lines.push(`Leader: ${l.name}${l.title ? `, ${l.title}` : ''}${l.org ? ` (${l.org})` : ''}`);
    lines.push(`  Others who completed survey: ${l.raterCount}`);
    lines.push(`  TRUST (A1–A7, 1–5 scale):       Self ${fmt(l.selfScores.trust)}  | Others ${fmt(l.othersScores.trust)}  | Gap ${gap(l.selfScores.trust, l.othersScores.trust)}`);
    lines.push(`  PROACTIVITY (B1–B6, 1–5):        Self ${fmt(l.selfScores.proactivity)}  | Others ${fmt(l.othersScores.proactivity)}  | Gap ${gap(l.selfScores.proactivity, l.othersScores.proactivity)}`);
    lines.push(`  PRODUCTIVITY (C1–C6, 1–5):       Self ${fmt(l.selfScores.productivity)}  | Others ${fmt(l.othersScores.productivity)}  | Gap ${gap(l.selfScores.productivity, l.othersScores.productivity)}`);
    lines.push(`  TP3 Index (others avg, 1–5):     ${fmt(l.othersScores.tp3)} — ${label(l.othersScores.tp3)}`);
    lines.push(`  Overall Impact D1:  Self ${l.selfScores.impact != null ? l.selfScores.impact.toFixed(1) : 'n/a'} | Others ${l.othersScores.impact != null ? l.othersScores.impact.toFixed(2) : 'n/a'}`);
    lines.push(`  Bench / Succession (F1–F2, 1–5): Others ${fmt(l.othersScores.bench)}`);
  }

  // Team roster — members WITHOUT diagnostic data (non-participating buyer,
  // coaching-only members, or someone mid-cycle). Context only, never scored.
  if (rosterList.length) {
    lines.push('');
    lines.push('=== TEAM ROSTER (no diagnostic data — context only, do NOT score) ===');
    for (const r of rosterList) {
      lines.push(`- ${r.name || 'Team member'}${r.role ? `, ${r.role}` : ''}${r.note ? ` (${r.note})` : ''}`);
    }
    lines.push('Acknowledge these people as part of the team where relevant (e.g., bench, span of control, who is and isn\'t in the feedback picture), but do not assign them scores or invent assessment data for them.');
  }

  // Team aggregate
  const validT  = leaders.map(l => l.othersScores.trust).filter(s => s != null);
  const validPr = leaders.map(l => l.othersScores.proactivity).filter(s => s != null);
  const validPd = leaders.map(l => l.othersScores.productivity).filter(s => s != null);
  const validTP = leaders.map(l => l.othersScores.tp3).filter(s => s != null);
  const validIm = leaders.map(l => l.othersScores.impact).filter(s => s != null);
  const validBn = leaders.map(l => l.othersScores.bench).filter(s => s != null);
  const teamT  = avg(validT);
  const teamPr = avg(validPr);
  const teamPd = avg(validPd);
  const teamTP = avg(validTP);
  const teamIm = avg(validIm);
  const teamBn = avg(validBn);

  lines.push('', '=== TEAM AGGREGATE (OTHERS SCORES) ===');
  lines.push(`  Trust avg:          ${fmt(teamT)}/5.0 — ${label(teamT)}`);
  lines.push(`  Proactivity avg:    ${fmt(teamPr)}/5.0 — ${label(teamPr)}`);
  lines.push(`  Productivity avg:   ${fmt(teamPd)}/5.0 — ${label(teamPd)}`);
  lines.push(`  TP3 Index avg:      ${fmt(teamTP)}/5.0 — ${label(teamTP)}`);
  lines.push(`  Impact D1 avg:      ${fmt(teamIm)}`);
  lines.push(`  Bench avg:          ${fmt(teamBn)}/5.0 — ${label(teamBn)}`);

  // Self vs others gap flags
  const gapRows = leaders.filter(l =>
    (l.selfScores.trust != null && l.othersScores.trust != null && Math.abs(l.othersScores.trust - l.selfScores.trust) >= 0.5) ||
    (l.selfScores.proactivity != null && l.othersScores.proactivity != null && Math.abs(l.othersScores.proactivity - l.selfScores.proactivity) >= 0.5) ||
    (l.selfScores.productivity != null && l.othersScores.productivity != null && Math.abs(l.othersScores.productivity - l.selfScores.productivity) >= 0.5)
  );
  if (gapRows.length > 0) {
    lines.push('', '  Significant self–others gaps (±0.5 or more):');
    for (const l of gapRows) {
      const parts = [];
      if (l.selfScores.trust != null && l.othersScores.trust != null && Math.abs(l.othersScores.trust - l.selfScores.trust) >= 0.5)
        parts.push(`Trust ${gap(l.selfScores.trust, l.othersScores.trust)}`);
      if (l.selfScores.proactivity != null && l.othersScores.proactivity != null && Math.abs(l.othersScores.proactivity - l.selfScores.proactivity) >= 0.5)
        parts.push(`Proactivity ${gap(l.selfScores.proactivity, l.othersScores.proactivity)}`);
      if (l.selfScores.productivity != null && l.othersScores.productivity != null && Math.abs(l.othersScores.productivity - l.selfScores.productivity) >= 0.5)
        parts.push(`Productivity ${gap(l.selfScores.productivity, l.othersScores.productivity)}`);
      lines.push(`    ${l.name}: ${parts.join(' | ')}`);
    }
  }

  // Verbatim themes
  if (verbatims.length > 0) {
    const sections = [
      { label: 'Trust open-ended (A8–A10)',          codes: ['A8','A9','A10'] },
      { label: 'Proactivity open-ended (B7–B10)',    codes: ['B7','B8','B9','B10'] },
      { label: 'Productivity open-ended (C7–C9)',    codes: ['C7','C8','C9'] },
      { label: 'Overall impact comments (D2)',        codes: ['D2'] },
      { label: 'Bench / succession comments (F3)',   codes: ['F3'] },
    ];
    lines.push('', '=== OPEN-ENDED VERBATIM THEMES ===');
    lines.push('(Paraphrase in the report — do not quote directly)');
    for (const sec of sections) {
      const relevant = verbatims.filter(v => sec.codes.includes(v.code));
      if (relevant.length === 0) continue;
      lines.push('', `${sec.label}:`);
      for (const v of relevant) {
        lines.push(`  [${v.leader}]:`);
        v.texts.slice(0, 3).forEach(t => lines.push(`    - ${t}`));
      }
    }
  }

  // Confidential qualitative context: coaching notes + 1:1 interview themes. The
  // sponsor requested these interviews and is entitled to the THEMES — never the
  // raw notes, verbatim quotes, or anything traceable to a named individual.
  const qualBlocks = leaders.filter(l => l.qualitative && (l.qualitative.coaching || l.qualitative.interviews));
  if (qualBlocks.length > 0) {
    lines.push('', '=== CONFIDENTIAL QUALITATIVE CONTEXT — THEMES ONLY ===');
    lines.push('The sponsor commissioned these 1:1 interviews and coaching conversations and is entitled to the PATTERNS. STRICT RULES, no exceptions:');
    lines.push('- Synthesize THEMES and PATTERNS only. Never quote any sentence verbatim or near-verbatim.');
    lines.push('- Never name, number, or otherwise identify an interviewee or make any observation traceable to one person. Aggregate (e.g., "those interviewed consistently describe…").');
    lines.push('- Do NOT reproduce or lightly paraphrase the raw notes below; distill them into a few high-level themes that align with the quantitative findings.');
    lines.push('- If a theme appears in only one interview and would expose who said it, generalize it or leave it out.');
    for (const l of qualBlocks) {
      lines.push('', `Leader: ${l.name}`);
      if (l.qualitative.coaching)   lines.push(`Coaching notes (extract themes only):\n${l.qualitative.coaching}`);
      if (l.qualitative.interviews) lines.push(`1:1 interview notes (extract themes only; do NOT name or number interviewees in the report):\n${l.qualitative.interviews}`);
    }
  }

  lines.push('', 'Generate the full team diagnostic report following the section format above.');
  return lines.join('\n');
}

// ── Import survey data (test/manual data entry) ──────────────────────────────
async function handleImportSurveyData(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' }); // P0-4 2026-07-01
  const { diagnostic_id, raters } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  if (!/^[0-9a-fA-F-]{36}$/.test(diagnostic_id)) return res.status(400).json({ error: 'Invalid diagnostic_id' }); // P0-4
  if (!Array.isArray(raters) || raters.length === 0) return res.status(400).json({ error: 'raters array required' });
  if (raters.length > 25) return res.status(400).json({ error: 'Max 25 raters per import' });

  try {
    const now = new Date().toISOString();
    let raterCount = 0;
    let responseCount = 0;

    for (const rater of raters) {
      if (!rater.name || !rater.email || !rater.relationship) continue;

      // Insert rater record — mark completed immediately so it counts toward the report
      const raterRes = await sb('/rest/v1/diagnostic_raters', 'POST', {
        diagnostic_id,
        name:         rater.name,
        email:        rater.email,
        relationship: rater.relationship,
        is_self:      rater.is_self === true || rater.is_self === 'true' || rater.is_self === 'TRUE',
        invited_at:   now,
        completed_at: now,
      }, { Prefer: 'return=representation' });

      const raterData = await raterRes.json();
      if (!Array.isArray(raterData) || !raterData[0]?.id) {
        console.error('[import] Failed to insert rater:', rater.name, raterData);
        continue;
      }
      const raterId = raterData[0].id;
      raterCount++;

      // Build response rows — rated scores + text responses
      const rows = [];
      for (const [code, score] of Object.entries(rater.scores || {})) {
        const n = Number(score);
        if (isNaN(n) || n <= 0) continue;
        rows.push({ rater_id: raterId, diagnostic_id, question_code: code, score: n, submitted_at: now });
      }
      for (const [code, text] of Object.entries(rater.texts || {})) {
        if (!text || !String(text).trim()) continue;
        rows.push({ rater_id: raterId, diagnostic_id, question_code: code, text_response: String(text).trim(), submitted_at: now });
      }
      if (rows.length > 0) {
        await sb('/rest/v1/diagnostic_responses', 'POST', rows, { Prefer: 'return=minimal' });
        responseCount += rows.length;
      }
    }

    return res.status(200).json({ rater_count: raterCount, response_count: responseCount });
  } catch (err) {
    console.error('[import-survey-data] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGenerateTeamReport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  // Coach-session gate: this endpoint now feeds coaching + interview notes into the
  // prompt, so it must never be reachable anonymously.
  if (!verifyCoachSession(req.body?.session)) return res.status(401).json({ error: 'Unauthorized' });

  const { diagnostic_ids, org_name, team_name, prepared_for_name, prepared_for_title, assessment_date_range, sector_type, team_id, roster } = req.body || {};
  const rosterList = Array.isArray(roster) ? roster : [];

  if (!Array.isArray(diagnostic_ids) || diagnostic_ids.length < 1) {
    return res.status(400).json({ error: 'At least 1 leader with a completed diagnostic is required for a team report.' });
  }
  if (!team_name) {
    return res.status(400).json({ error: 'team_name is required.' });
  }

  try {
    // ── 1. Fetch all selected diagnostics ──────────────────────────────────────
    const idFilter = diagnostic_ids.map(id => `"${id}"`).join(',');
    const diagsRes = await sb(
      `/rest/v1/diagnostics?id=in.(${idFilter})&select=id,client_name,client_title,client_org,coaching_notes,interview_notes_json`
    );
    const diags = await diagsRes.json();
    if (!Array.isArray(diags) || diags.length < 1) {
      return res.status(400).json({ error: 'Could not find a valid diagnostic for the provided IDs.' });
    }

    // ── 2. For each diagnostic, compute self + others scores ──────────────────
    const leaders      = [];
    let   totalRaters  = 0;
    const allVerbatims = [];

    for (const diag of diags) {
      // Self rater
      const selfRaterRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.true&limit=1&select=id`
      );
      const selfRaters = await selfRaterRes.json();

      // Others raters (completed)
      const othersRatersRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&completed_at=not.is.null&select=id`
      );
      const othersRaters = await othersRatersRes.json();
      totalRaters += (othersRaters || []).length;

      // Self responses
      const selfScoreMap = {};
      if (selfRaters?.length > 0) {
        const selfId = selfRaters[0].id;
        const selfRespRes = await sb(
          `/rest/v1/diagnostic_responses?rater_id=eq.${selfId}&diagnostic_id=eq.${diag.id}&select=question_code,score`
        );
        const selfResps = await selfRespRes.json();
        (selfResps || []).forEach(r => {
          if (r.score != null) selfScoreMap[r.question_code] = Number(r.score);
        });
      }

      // Others responses (scores + open-ended text). Hard-cut anonymity stores
      // others' responses with rater_id = NULL, so a rater_id=in.(...) filter
      // returns nothing (this was the "others scores unavailable" bug). Fetch ALL
      // responses for the diagnostic and keep the non-self rows: anonymous rows
      // (rater_id NULL — never the self-assessment) plus any rows still linked to
      // a completed non-self rater. The self rater is always excluded.
      const selfRaterId       = (selfRaters && selfRaters[0]) ? selfRaters[0].id : null;
      const completedOtherIds = new Set((othersRaters || []).map(r => r.id));
      const allRespRes = await sb(
        `/rest/v1/diagnostic_responses?diagnostic_id=eq.${diag.id}&select=rater_id,question_code,score,text_response,rater_relationship`
      );
      const allResps = await allRespRes.json() || [];
      const othersResponses = (Array.isArray(allResps) ? allResps : []).filter(r =>
        r.rater_id == null
          ? true
          : (r.rater_id !== selfRaterId && completedOtherIds.has(r.rater_id))
      );

      // Compute others scores via existing helpers
      const scores = buildScoreSummary(othersResponses);

      // Compute self dimension averages
      const selfTrust        = avg(['A1','A2','A3','A4','A5','A6','A7'].map(c => selfScoreMap[c]).filter(s => s != null && !isNaN(s)));
      const selfProactivity  = avg(['B1','B2','B3','B4','B5','B6'].map(c => selfScoreMap[c]).filter(s => s != null && !isNaN(s)));
      const selfProductivity = avg(['C1','C2','C3','C4','C5','C6'].map(c => selfScoreMap[c]).filter(s => s != null && !isNaN(s)));
      const selfImpact       = selfScoreMap['D1'] != null ? Number(selfScoreMap['D1']) : null;

      // Collect verbatims for theme section
      const verbatims = collectVerbatims(othersResponses);
      for (const [code, texts] of Object.entries(verbatims)) {
        allVerbatims.push({ leader: diag.client_name, code, texts });
      }

      // Qualitative themes context (sponsor commissioned the interviews, so they
      // get the THEMES). Interviewee names are deliberately omitted here; the
      // prompt enforces themes-only, no quotes, no attribution.
      const coachingNotesText = (diag.coaching_notes || '').trim();
      const ivEntries = Array.isArray(diag.interview_notes_json) ? diag.interview_notes_json : [];
      const interviewsThemeText = ivEntries.map((iv, i) => {
        const nt = (iv && iv.notes) ? String(iv.notes).trim() : '';
        const dt = (iv && iv.date) ? iv.date : 'n/a';
        return nt ? `Interview ${i + 1} (${dt}):\n${nt}` : '';
      }).filter(Boolean).join('\n\n');

      leaders.push({
        name:  diag.client_name,
        title: diag.client_title || '',
        org:   diag.client_org   || '',
        raterCount: (othersRaters || []).length,
        qualitative: { coaching: coachingNotesText, interviews: interviewsThemeText },
        selfScores: {
          trust:        selfTrust,
          proactivity:  selfProactivity,
          productivity: selfProductivity,
          impact:       selfImpact,
        },
        othersScores: {
          trust:        scores.trustScore,
          proactivity:  scores.proactivityScore,
          productivity: scores.productivityScore,
          tp3:          scores.tp3Index,
          impact:       scores.impactScore,
          bench:        scores.benchScore,
        },
      });
    }

    // ── 3. Build prompt & call Claude ──────────────────────────────────────────
    const userPrompt = buildTeamReportPrompt({
      org_name, team_name, prepared_for_name, prepared_for_title,
      assessment_date_range, sector_type,
      leaders,
      total_raters: totalRaters,
      verbatims:    allVerbatims,
      roster:       rosterList,
    });

    const reportText = await callClaude(TEAM_REPORT_SYSTEM_PROMPT, userPrompt, 8192);
    if (!reportText) return res.status(500).json({ error: 'Claude returned an empty response.' });

    // ── 4. Store in Supabase ───────────────────────────────────────────────────
    // Stored UNAPPROVED (sponsor_visible:false): the coach reviews, then publishes
    // it to the sponsor's Decision Room page from the team management view.
    const now = new Date().toISOString();
    const storeRes = await sb('/rest/v1/diagnostic_team_reports', 'POST', {
      org_name:              org_name   || '',
      team_name:             team_name  || '',
      prepared_for_name:     prepared_for_name  || '',
      prepared_for_title:    prepared_for_title || '',
      assessment_date_range: assessment_date_range || '',
      sector_type:           sector_type || 'private',
      diagnostic_ids:        JSON.stringify(diagnostic_ids),
      team_id:               team_id || null,
      roster_json:           JSON.stringify(rosterList),
      sponsor_visible:       false,
      num_leaders:           leaders.length,
      total_raters:          totalRaters,
      content_text:          reportText,
      generated_at:          now,
      updated_at:            now,
    }, { Prefer: 'return=representation' });
    let newId = null;
    try { const rows = await storeRes.json(); if (Array.isArray(rows) && rows[0]) newId = rows[0].id; } catch (_) {}

    return res.status(200).json({
      id:           newId,
      report:       reportText,
      num_leaders:  leaders.length,
      total_raters: totalRaters,
      roster_count: rosterList.length,
      generated_at: now,
    });

  } catch (err) {
    console.error('[diagnostic/generate-team-report] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL SEQUENCE SYSTEM
// DiagnosticFinalized → coach generates drafts → reviews/edits → approves →
// cron (send-reminders.js hourly pass) sends on schedule.
// Sponsor E4-E7 auto-cancel when sprint_purchased_at is set.
// ═══════════════════════════════════════════════════════════════════════════════

// GPS-branded email shell for sequence emails.
function diagEmailShell(title, inner) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
    <div style="background:#004369;padding:20px 28px;border-radius:8px 8px 0 0;">
      <div style="color:#E5DDC8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;">${title}</div>
    </div>
    <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
      ${inner}
      <p style="margin-top:28px;">– Alex Tremble<br><span style="color:#666;font-size:13px;">GPS Leadership Solutions</span></p>
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;">
        Questions? Reply to this email or reach out to alex@gpsleadership.org.
      </div>
    </div>
  </div>`;
}

// Add calendar days to a YYYY-MM-DD date string, return ISO timestamptz (UTC).
function addDaysToDate(dateStr, days, hourUtc) {
  if (!dateStr) return null;
  var h = typeof hourUtc === 'number' ? hourUtc : 14;
  var d = new Date(dateStr + 'T' + String(h).padStart(2, '0') + ':00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: generate-email-drafts
// POST /api/diagnostic?action=generate-email-drafts
// Body: { diagnostic_id, session }
//
// Generates all E1/E1b (leader) + E2-E7 (sponsor) drafts via Claude and stores
// them in email_drafts. Deletes any prior drafts for this diagnostic first.
// Coach must call approve-email-sequence before any draft sends.
// ─────────────────────────────────────────────────────────────────────────────
async function handleGenerateEmailDrafts(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });

  try {
    // ── 1. Load diagnostic ───────────────────────────────────────────────────
    const diagR = await sb(`/rest/v1/diagnostics?id=eq.${encodeURIComponent(diagnostic_id)}&select=id,client_id,client_name,client_title,client_org,client_email,debrief_date,report_doc,leader_token&limit=1`);
    const diag = diagR.ok ? ((await diagR.json())[0] || null) : null;
    if (!diag) return res.status(404).json({ error: 'Diagnostic not found' });

    // ── 2. Load TP3 scores ───────────────────────────────────────────────────
    const scoresR = await sb(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${encodeURIComponent(diagnostic_id)}&select=scores_json&order=generated_at.desc&limit=1`);
    const scores = scoresR.ok ? (((await scoresR.json())[0] || {}).scores_json || {}) : {};

    // ── 3. Find primary sponsor team for this leader ─────────────────────────
    // Proper 3-step join: team_members → sponsor_teams → sponsors
    let sponsor = null;
    let stLink = null;
    var backedRecs = [];
    if (diag.client_id) {
      const tmR = await sb('/rest/v1/team_members?client_id=eq.' + encodeURIComponent(diag.client_id) + '&select=team_id&limit=1');
      var tmRows = tmR.ok ? await tmR.json() : [];
      var tmTeamId = (Array.isArray(tmRows) && tmRows[0]) ? tmRows[0].team_id : null;
      if (tmTeamId) {
        const stLinkR = await sb('/rest/v1/sponsor_teams?team_id=eq.' + encodeURIComponent(tmTeamId) + '&select=id,sponsor_id,rec_commitments,sponsor_debrief_date&limit=1');
        var stLinkRows = stLinkR.ok ? await stLinkR.json() : [];
        stLink = (Array.isArray(stLinkRows) && stLinkRows[0]) ? stLinkRows[0] : null;
        if (stLink && stLink.sponsor_id) {
          const spR = await sb('/rest/v1/sponsors?id=eq.' + encodeURIComponent(stLink.sponsor_id) + '&select=id,name,email,sponsor_token&limit=1');
          var spRows = spR.ok ? await spR.json() : [];
          var sponsorInfo = (Array.isArray(spRows) && spRows[0]) ? spRows[0] : null;
          if (sponsorInfo) {
            sponsor = { sponsor_name: sponsorInfo.name || '', sponsor_email: sponsorInfo.email || '', sponsor_token: sponsorInfo.sponsor_token || '' };
            var rcMap = stLink.rec_commitments || {};
            var backedKeys = Object.entries(rcMap).filter(function(e) { return e[1] === 'commit'; }).map(function(e) { return e[0]; });
            if (backedKeys.length) {
              var recR = await sb('/rest/v1/recommendations?id=in.(' + backedKeys.map(function(k) { return encodeURIComponent(k); }).join(',') + ')&select=short_title&limit=20');
              var recRows = recR.ok ? await recR.json() : [];
              backedRecs = (Array.isArray(recRows) ? recRows : []).map(function(r) { return r.short_title; }).filter(Boolean);
            }
          }
        }
      }
    }

    var leaderFirst = String(diag.client_name || '').trim().split(/\s+/)[0] || 'the leader';
    var debriefDateFmt = diag.debrief_date
      ? new Date(diag.debrief_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : 'the upcoming debrief';
    var leaderReportUrl = diag.leader_token ? (PORTAL_BASE + '/diagnostic-leader?token=' + encodeURIComponent(diag.leader_token)) : '[leader report link]';
    var decisionRoomUrl = (sponsor && sponsor.sponsor_token) ? (PORTAL_BASE + '/decision-room?token=' + encodeURIComponent(sponsor.sponsor_token)) : null;
    var drUrl = decisionRoomUrl || '[Decision Room link]';

    // Pull a few report themes for context if available
    var reportThemes = '';
    if (diag.report_doc && Array.isArray(diag.report_doc.sections)) {
      var themeSection = diag.report_doc.sections.find(function(s) { return s.key === 'key_strengths' || s.key === 'blind_spots'; });
      if (themeSection && themeSection.body) reportThemes = String(themeSection.body).slice(0, 600);
    }

    // ── 4. Build Claude prompt ───────────────────────────────────────────────
    var emailCount = sponsor ? 8 : 2;
    var spName = sponsor ? (sponsor.sponsor_name || 'the sponsor') : '';
    var backedLine = backedRecs.length
      ? ('The sponsor has already committed to these recommendations: ' + backedRecs.join(', ') + '.')
      : 'No recommendations have been backed yet in the Decision Room.';

    var seqSystem = 'You are drafting a personalized diagnostic follow-up email sequence for GPS Leadership Solutions. Write in Alex Tremble\'s voice: direct, candid, warm, plain language, short sentences. No hype, no buzzwords, no emoji. Avoid em dashes; use commas, periods, or semicolons.\n\n'
      + 'Return ONLY a JSON object: { "emails": [ { "email_key": "E1", "subject": "...", "body_text": "..." }, ... ] }. No prose, no code fences.\n\n'
      + 'body_text rules: plain paragraphs separated by blank lines; bullets use "- " prefix on a new line; no markdown headers; no invented facts beyond what is provided; never mention pricing.\n\n'
      + 'EMAILS TO GENERATE:\n\n'

      // E1: pre-debrief to leader
      + 'E1 (TO LEADER: ' + (diag.client_name || 'the leader') + ', sent 24 hours before debrief on ' + debriefDateFmt + '):\n'
      + 'Subject: something like "Your report is ready" or "Before tomorrow."\n'
      + 'This email must include all of the following points:\n'
      + '1. Their Diagnostic Leader Report is ready. Include this link on its own line: ' + leaderReportUrl + '\n'
      + '2. "Skim it once before we meet. Note anything that surprises you, or that you want to push back on."\n'
      + '3. "Please do not share the report with anyone yet -- we will interpret it together."\n'
      + '4. One sentence on what to expect: we will go through the findings together and discuss what comes next.\n'
      + 'Tone: warm, direct. Under 175 words.\n\n'

      // E1b: post-debrief to leader
      + 'E1b (TO LEADER: ' + (diag.client_name || 'the leader') + ', sent afternoon of the debrief day):\n'
      + 'Subject: something like "Thank you" or "What comes next."\n'
      + 'Thank them for the conversation today. Reference the key themes that came out of it (keep high-level and general -- do not invent specifics). The next step is the 90-day sprint: this is how they take the diagnostic findings and build a concrete development plan with real coaching support behind it. Close by saying Alex will be in touch with the details. Under 200 words.\n\n'

      + (sponsor ? (
        // E2: pre-debrief to sponsor
          'E2 (TO SPONSOR: ' + spName + ', sent 24 hours before debrief on ' + debriefDateFmt + '):\n'
        + 'Subject: something like "Heads up before tomorrow."\n'
        + 'Brief note that the debrief with ' + (diag.client_name || 'the leader') + ' is tomorrow. Context: this is where we go through the diagnostic findings and identify the key development focus for the next 90 days. After the debrief, the sponsor will hear from Alex with next steps and access to the recommendations. Keep it short and professional. Under 150 words.\n\n'

        // E3: post-debrief to sponsor
        + 'E3 (TO SPONSOR: ' + spName + ', sent the day after the debrief):\n'
        + 'Subject: something like "The debrief is done -- here is what comes next."\n'
        + 'The debrief with ' + (diag.client_name || 'the leader') + ' is complete. Key development themes have been identified. Their role as sponsor is to review the recommendations and back the ones they are willing to support going into the 90-day sprint. Give them the Decision Room link:\n'
        + drUrl + '\n'
        + 'Brief and professional. Under 175 words.\n\n'

        // E4: sprint invite to sponsor
        + 'E4 (TO SPONSOR: ' + spName + ', sent 3 days after debrief):\n'
        + 'Subject: something like "The sprint window is open."\n'
        + backedLine + ' The 90-day sprint is how those commitments become real behavior change with accountability. The sprint window is open for 7 days. Invite them to confirm their commitment so we can move forward. Include the Decision Room link: ' + drUrl + '. Under 175 words.\n\n'

        // E5: reminder to sponsor
        + 'E5 (TO SPONSOR: ' + spName + ', sent 5 days after debrief):\n'
        + 'Subject: something like "2 days left."\n'
        + 'Short, direct reminder. Sprint window closes in 2 days. No pressure, but clear on what is at stake. Include the link: ' + drUrl + '. Under 100 words.\n\n'

        // E6: last day to sponsor
        + 'E6 (TO SPONSOR: ' + spName + ', sent 7 days after debrief -- last day of sprint window):\n'
        + 'Subject: something like "Last day."\n'
        + 'Very short. Today is the last day of the sprint window. One clear call to action. Link: ' + drUrl + '. Under 75 words.\n\n'

        // E7: post-window to sponsor
        + 'E7 (TO SPONSOR: ' + spName + ', sent 10 days after debrief):\n'
        + 'Subject: something like "The window has closed -- but there is still a path."\n'
        + 'The sprint window has passed. If they still want to move forward, the door is open. No pressure, keep it honest. Link: ' + drUrl + '. Under 150 words.'
      ) : '');

    var seqUser = [
      'Leader: ' + (diag.client_name || '') + (diag.client_title ? ', ' + diag.client_title : '') + (diag.client_org ? ' (' + diag.client_org + ')' : ''),
      'Debrief date: ' + debriefDateFmt,
      'TP3 scores (1-5): Trust ' + (scores.trust != null ? scores.trust : 'n/a') + ', Proactivity ' + (scores.proactivity != null ? scores.proactivity : 'n/a') + ', Productivity ' + (scores.productivity != null ? scores.productivity : 'n/a'),
      'TP3 focus pillar: ' + (scores.tp3_pillar || 'not set'),
      sponsor ? 'Sponsor: ' + (sponsor.sponsor_name || '') + ' (' + (diag.client_org || 'the company') + ')' : 'No sponsor team on file -- generating leader emails only.',
      backedRecs.length ? 'Backed recommendations (sponsor committed): ' + backedRecs.join('; ') : 'No recommendations backed yet.',
      reportThemes ? 'Report themes (context only -- do not quote directly):\n' + reportThemes : '',
      '',
      'Draft all ' + emailCount + ' emails now.',
    ].filter(Boolean).join('\n');

    var raw = await callClaude(seqSystem, seqUser, 4000, { model: CLAUDE_REPORT_MODEL, timeoutMs: 110000, temperature: 0.3, retries: 1 });
    var parsed = parseJsonLoose(raw);
    if (!parsed || !Array.isArray(parsed.emails) || !parsed.emails.length) {
      return res.status(502).json({ error: 'Could not generate email drafts. Please try again.' });
    }

    // ── 5. Compute scheduled_for for each draft ──────────────────────────────
    var OFFSETS = {
      'E1':  { days: -1, hour: 14 },  // 10am ET day before
      'E1B': { days:  0, hour: 21 },  // 5pm ET day of debrief
      'E1b': { days:  0, hour: 21 },
      'E2':  { days: -1, hour: 14 },
      'E3':  { days:  1, hour: 14 },
      'E4':  { days:  3, hour: 14 },
      'E5':  { days:  5, hour: 14 },
      'E6':  { days:  7, hour: 14 },
      'E7':  { days: 10, hour: 14 },
    };

    // ── 6. Delete existing drafts ────────────────────────────────────────────
    await sb('/rest/v1/email_drafts?diagnostic_id=eq.' + encodeURIComponent(diagnostic_id), 'DELETE');

    // ── 7. Build and insert new rows ─────────────────────────────────────────
    var now = new Date().toISOString();
    var rows = parsed.emails.map(function(e) {
      var key = String(e.email_key || '').trim().toUpperCase().replace('1B', '1b').replace(/^E1B$/, 'E1b');
      var isLeader = ['E1', 'E1b'].includes(key);
      var off = OFFSETS[key];
      var scheduledFor = (off && diag.debrief_date) ? addDaysToDate(diag.debrief_date, off.days, off.hour) : null;
      return {
        diagnostic_id: diagnostic_id,
        email_key: key,
        sequence: isLeader ? 'leader' : 'sponsor',
        subject: String(e.subject || ''),
        body: String(e.body_text || e.body || ''),
        to_name:  isLeader ? (diag.client_name || '') : (sponsor ? (sponsor.sponsor_name || '') : ''),
        to_email: isLeader ? (diag.client_email || '') : (sponsor ? (sponsor.sponsor_email || '') : ''),
        scheduled_for: scheduledFor,
        status: 'draft',
        created_at: now,
        updated_at: now,
      };
    });

    var insertR = await sb('/rest/v1/email_drafts', 'POST', rows, { Prefer: 'return=representation' });
    var inserted = insertR.ok ? await insertR.json() : rows;

    return res.status(200).json({ ok: true, count: (Array.isArray(inserted) ? inserted : rows).length, drafts: Array.isArray(inserted) ? inserted : rows });
  } catch (e) {
    console.error('[generate-email-drafts]', e);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: get-email-drafts
// POST /api/diagnostic?action=get-email-drafts
// Body: { diagnostic_id, session }
// Returns all drafts for a diagnostic plus approval / purchased state.
// ─────────────────────────────────────────────────────────────────────────────
async function handleGetEmailDrafts(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const r = await sb('/rest/v1/email_drafts?diagnostic_id=eq.' + encodeURIComponent(diagnostic_id) + '&order=email_key.asc');
    const rows = r.ok ? await r.json() : [];
    const dr = await sb('/rest/v1/diagnostics?id=eq.' + encodeURIComponent(diagnostic_id) + '&select=emails_approved_by_coach,sprint_purchased_at&limit=1');
    const diagInfo = dr.ok ? ((await dr.json())[0] || {}) : {};
    return res.status(200).json({
      ok: true,
      drafts: Array.isArray(rows) ? rows : [],
      emails_approved_by_coach: !!(diagInfo.emails_approved_by_coach),
      sprint_purchased_at: diagInfo.sprint_purchased_at || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: update-email-draft
// POST /api/diagnostic?action=update-email-draft
// Body: { draft_id, subject, body, session }
// Saves coach edits to a draft (subject and/or body). Only works on draft/scheduled rows.
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpdateEmailDraft(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { draft_id, subject, body, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!draft_id) return res.status(400).json({ error: 'draft_id required' });
  try {
    var update = { updated_at: new Date().toISOString() };
    if (subject !== undefined) update.subject = String(subject);
    if (body !== undefined) update.body = String(body);
    const r = await sb('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draft_id) + '&status=in.(draft,scheduled)', 'PATCH', update, { Prefer: 'return=minimal' });
    if (!r.ok) return res.status(400).json({ error: 'Could not update draft -- it may already be sent or cancelled.' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: approve-email-sequence
// POST /api/diagnostic?action=approve-email-sequence
// Body: { diagnostic_id, session }
//
// Sets emails_approved_by_coach=true and promotes all draft→scheduled.
// Leader emails (E1, E1b) always schedule. Sponsor emails (E2-E7) only
// schedule if sprint_purchased_at is null (sprint not yet bought).
// ─────────────────────────────────────────────────────────────────────────────
async function handleApproveEmailSequence(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const dr = await sb('/rest/v1/diagnostics?id=eq.' + encodeURIComponent(diagnostic_id) + '&select=sprint_purchased_at&limit=1');
    const diagInfo = dr.ok ? ((await dr.json())[0] || {}) : {};
    const now = new Date().toISOString();

    // Promote leader drafts unconditionally
    await sb('/rest/v1/email_drafts?diagnostic_id=eq.' + encodeURIComponent(diagnostic_id) + '&sequence=eq.leader&status=eq.draft',
      'PATCH', { status: 'scheduled', updated_at: now }, { Prefer: 'return=minimal' });

    // Promote sponsor drafts only if sprint not yet purchased
    if (!diagInfo.sprint_purchased_at) {
      await sb('/rest/v1/email_drafts?diagnostic_id=eq.' + encodeURIComponent(diagnostic_id) + '&sequence=eq.sponsor&status=eq.draft',
        'PATCH', { status: 'scheduled', updated_at: now }, { Prefer: 'return=minimal' });
    }

    // Mark approved on the diagnostic record
    await sb('/rest/v1/diagnostics?id=eq.' + encodeURIComponent(diagnostic_id),
      'PATCH', { emails_approved_by_coach: true, updated_at: now }, { Prefer: 'return=minimal' });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: mark-sprint-purchased
// POST /api/diagnostic?action=mark-sprint-purchased
// Body: { diagnostic_id, session }
//
// Sets sprint_purchased_at = now(). Immediately cancels any unsent E4-E7
// sponsor follow-ups (the urgency sequence is no longer needed once bought).
// ─────────────────────────────────────────────────────────────────────────────
async function handleMarkSprintPurchased(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  try {
    const now = new Date().toISOString();
    await sb('/rest/v1/diagnostics?id=eq.' + encodeURIComponent(diagnostic_id),
      'PATCH', { sprint_purchased_at: now, updated_at: now }, { Prefer: 'return=minimal' });
    // Cancel unsent E4-E7 sponsor follow-ups
    await sb('/rest/v1/email_drafts?diagnostic_id=eq.' + encodeURIComponent(diagnostic_id) + '&sequence=eq.sponsor&email_key=in.(E4,E5,E6,E7)&status=in.(draft,scheduled)',
      'PATCH', { status: 'cancelled', updated_at: now }, { Prefer: 'return=minimal' });
    return res.status(200).json({ ok: true, sprint_purchased_at: now });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── ACTION: schedule-debrief-emails ──────────────────────────────────────────
// Auto-creates email_drafts with status='scheduled' when debrief dates are set.
// email_key suffix '_auto' identifies auto-scheduled vs. AI-generated drafts.
// Emails send automatically when scheduled_for arrives (cron picks them up).
// Calling again re-upserts — safe to call whenever dates change.
async function handleScheduleDebriefEmails(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
  const enc = encodeURIComponent;
  try {
    // Load diagnostic + client
    const diagR = await sb(`/rest/v1/diagnostics?id=eq.${enc(diagnostic_id)}&select=*&limit=1`);
    const diagRows = await diagR.json();
    const diag = diagRows[0];
    if (!diag) return res.status(404).json({ error: 'Diagnostic not found' });

    const clientR = await sb(`/rest/v1/clients?id=eq.${enc(diag.client_id)}&select=name,email&limit=1`);
    const client = (await clientR.json())[0] || {};

    const now = new Date().toISOString();
    const created = [];

    // Helper: upsert a draft (overwrite if same email_key + diagnostic_id, skip if sent/cancelled)
    async function upsertDraft(row) {
      // Don't overwrite already-sent or manually-cancelled drafts
      const existing = await sb(`/rest/v1/email_drafts?diagnostic_id=eq.${enc(diagnostic_id)}&email_key=eq.${enc(row.email_key)}&select=id,status&limit=1`);
      const existRows = await existing.json();
      if (existRows[0] && ['sent', 'cancelled'].includes(existRows[0].status)) return; // don't overwrite
      if (existRows[0]) {
        // Update scheduled_for and body in case date changed
        await sb(`/rest/v1/email_drafts?id=eq.${enc(existRows[0].id)}`, 'PATCH',
          { ...row, updated_at: now }, { Prefer: 'return=minimal' });
      } else {
        await sb('/rest/v1/email_drafts', 'POST',
          { ...row, diagnostic_id, created_at: now, updated_at: now }, { Prefer: 'return=minimal' });
      }
    }

    // ── Leader report-ready email (noon ET = 16:00 UTC day before debrief) ──
    if (diag.debrief_date && client.email) {
      const pts = diag.debrief_date.split('-');
      const sendAt = new Date(Date.UTC(+pts[0], +pts[1]-1, +pts[2]-1, 16, 0, 0)).toISOString();
      const firstName = (client.name || '').split(' ')[0] || client.name || 'there';
      const portalLink = `${PORTAL_BASE}/diagnostic-leader.html?token=${enc(diag.leader_token)}`;
      const debriefFmt = new Date(diag.debrief_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      await upsertDraft({
        email_key: 'report_ready_auto',
        sequence: 'auto',
        subject: `Your leadership report is ready`,
        body: `Hi ${firstName},\n\nYour GPS Leadership Diagnostic report is ready. You can view it now in your leader portal:\n\n${portalLink}\n\nI look forward to our debrief on ${debriefFmt}${diag.debrief_time ? ' at ' + diag.debrief_time : ''}. If you have any questions before we meet, feel free to reply to this email.\n\nSee you then.`,
        to_name: client.name || '',
        to_email: client.email,
        scheduled_for: sendAt,
        status: 'scheduled',
      });
      created.push('report_ready_auto');
    }

    // ── Sponsor emails (per sponsor_teams row with a sponsor_debrief_date) ──
    const stR = await sb(`/rest/v1/sponsor_teams?diagnostic_id=eq.${enc(diagnostic_id)}&sponsor_debrief_date=not.is.null&select=sponsor_id,sponsor_debrief_date`);
    const stRows = await stR.json();
    for (const st of (Array.isArray(stRows) ? stRows : [])) {
      if (!st.sponsor_debrief_date) continue;
      const spR = await sb(`/rest/v1/sponsors?id=eq.${enc(st.sponsor_id)}&select=id,name,email,sponsor_token&limit=1`);
      const sp = (await spR.json())[0];
      if (!sp || !sp.email) continue;

      const spts = st.sponsor_debrief_date.split('-');
      const drLink = `${PORTAL_BASE}/decision-room.html?token=${enc(sp.sponsor_token)}`;

      // Review request: noon ET day before their meeting
      const reviewAt = new Date(Date.UTC(+spts[0], +spts[1]-1, +spts[2]-1, 16, 0, 0)).toISOString();
      await upsertDraft({
        email_key: `sponsor_review_auto_${sp.id}`,
        sequence: 'auto',
        subject: `Please review ${diag.client_name}'s 90-day plan before our meeting`,
        body: `Hi ${sp.name},\n\nJust a heads-up before tomorrow's meeting. ${diag.client_name}'s 90-day development plan is ready for your review in the Decision Room:\n\n${drLink}\n\nYou can approve the plan, back specific recommendations, or request any changes — all before we sit down.\n\nSee you tomorrow.`,
        to_name: sp.name,
        to_email: sp.email,
        scheduled_for: reviewAt,
        status: 'scheduled',
      });
      created.push(`sponsor_review_auto_${sp.id}`);

      // Day-of reminder: 8am ET = 12:00 UTC
      const dayOfAt = new Date(Date.UTC(+spts[0], +spts[1]-1, +spts[2], 12, 0, 0)).toISOString();
      await upsertDraft({
        email_key: `sponsor_day_of_auto_${sp.id}`,
        sequence: 'auto',
        subject: `Today: ${diag.client_name}'s leadership development review`,
        body: `Hi ${sp.name},\n\nJust a quick reminder — we're meeting today to discuss ${diag.client_name}'s development plan.\n\n${drLink}\n\nLooking forward to it.`,
        to_name: sp.name,
        to_email: sp.email,
        scheduled_for: dayOfAt,
        status: 'scheduled',
      });
      created.push(`sponsor_day_of_auto_${sp.id}`);
    }

    return res.status(200).json({ ok: true, created });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Converts plain-text email body (paragraphs + "- " bullets) to simple HTML.
function diagBodyToHtml(text) {
  return String(text || '').split(/\n/).map(function(line) {
    if (/^-\s/.test(line)) return '<li style="margin-bottom:4px;">' + line.slice(2) + '</li>';
    return line.trim() ? '<p style="margin:0 0 14px;">' + line + '</p>' : '';
  }).join('\n').replace(/(<li[\s\S]*?<\/li>\n?)+/g, function(m) {
    return '<ul style="margin:0 0 14px;padding-left:20px;">' + m + '</ul>';
  });
}

// Sends a single scheduled email_draft immediately regardless of scheduled_for.
// Used by the "Send Now" button in coach.html, and by handleSendScheduled batch.
async function sendEmailDraft(draft) {
  if (!draft || !draft.to_email) throw new Error('Draft missing to_email');
  const titleMap = {
    E1: 'Preparing for our call tomorrow', E1b: 'Following up on our debrief',
    E2: 'A note before tomorrow', E3: 'Where things stand after the debrief',
    E4: 'The recommendations that shape the sprint', E5: 'Quick reminder — sprint window closing',
    E6: 'Last day to lock in the sprint', E7: 'Checking in on the development plan',
  };
  const title = titleMap[draft.email_key] || 'GPS Leadership Solutions';
  const html = diagEmailShell(title, diagBodyToHtml(draft.body || ''));
  await sendEmail({
    to: draft.to_email,
    subject: draft.subject || 'A note from Alex at GPS Leadership',
    html,
    text: String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    emailType: 'seq_' + String(draft.email_key || '').toLowerCase(),
    recipientName: draft.to_name || '',
  });
  const sentAt = new Date().toISOString();
  await sb('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draft.id),
    'PATCH', { status: 'sent', sent_at: sentAt, updated_at: sentAt }, { Prefer: 'return=minimal' });
}

// ── ACTION: send-email-draft-now ─────────────────────────────────────────────
// POST /api/diagnostic?action=send-email-draft-now
// Body: { draft_id, session }
// Sends a single draft immediately, bypassing the scheduled_for time.
// Works on status=draft or status=scheduled. Marks it sent.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSendEmailDraftNow(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { draft_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!draft_id) return res.status(400).json({ error: 'draft_id required' });
  try {
    const r = await sb('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draft_id) + '&status=in.(draft,scheduled)&select=id,email_key,subject,body,to_name,to_email&limit=1');
    const rows = r.ok ? await r.json() : [];
    const draft = Array.isArray(rows) ? rows[0] : null;
    if (!draft) return res.status(404).json({ error: 'Draft not found or already sent/cancelled.' });
    await sendEmailDraft(draft);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[send-email-draft-now]', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── ACTION: approve-email-draft ──────────────────────────────────────────────
// POST /api/diagnostic?action=approve-email-draft
// Body: { draft_id, session }
// Promotes a single email draft from 'draft' → 'scheduled'.
// ─────────────────────────────────────────────────────────────────────────────
async function handleApproveEmailDraft(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { draft_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!draft_id) return res.status(400).json({ error: 'draft_id required' });
  try {
    const r = await sb('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draft_id) + '&status=eq.draft',
      'PATCH', { status: 'scheduled', updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    if (!r.ok) return res.status(400).json({ error: 'Could not approve draft -- it may already be scheduled or sent.' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── ACTION: hold-email-draft ──────────────────────────────────────────────────
// POST /api/diagnostic?action=hold-email-draft
// Body: { draft_id, session }
// Moves a scheduled email back to 'draft' so it will not send until re-approved.
// ─────────────────────────────────────────────────────────────────────────────
async function handleHoldEmailDraft(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { draft_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!draft_id) return res.status(400).json({ error: 'draft_id required' });
  try {
    const r = await sb('/rest/v1/email_drafts?id=eq.' + encodeURIComponent(draft_id) + '&status=eq.scheduled',
      'PATCH', { status: 'draft', updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    if (!r.ok) return res.status(400).json({ error: 'Could not hold this email -- it may already be sent or cancelled.' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── ACTION: cancel-scheduled-email ───────────────────────────────────────────
// Moves a single email_draft to 'cancelled'. Coach uses this from the Today
// list to stop an auto-scheduled email before it goes out.
async function handleCancelScheduledEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { draft_id, session } = req.body || {};
  if (!verifyCoachSession(session)) return res.status(401).json({ error: 'Unauthorized' });
  if (!draft_id) return res.status(400).json({ error: 'draft_id required' });
  try {
    await sb(`/rest/v1/email_drafts?id=eq.${encodeURIComponent(draft_id)}`,
      'PATCH', { status: 'cancelled', updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
