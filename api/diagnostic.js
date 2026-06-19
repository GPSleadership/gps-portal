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
// Plain-text template body (blank-line or single-newline separated) → HTML <p> paragraphs.
function tplBodyToHtml(text) {
  return String(text || '').split(/\n{2,}|\n/).map(l => l.trim()).filter(Boolean)
    .map(l => `<p style="margin:0 0 14px;">${l}</p>`).join('');
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-cron');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'send-invites':         return handleSendInvites(req, res);
    case 'schedule-invites':     return handleScheduleInvites(req, res);
    case 'send-scheduled':       return handleSendScheduled(req, res);
    case 'trial-sweep':          return handleTrialSweep(req, res);
    case 'send-leader-link':     return handleSendLeaderLink(req, res);
    case 'resend-rater':         return handleResendRater(req, res);
    case 'generate-question':    return handleGenerateQuestion(req, res);
    case 'generate-g2-question': return handleGenerateG2Question(req, res);
    case 'generate-report':      return handleGenerateReport(req, res);
    case 'import-survey-data':   return handleImportSurveyData(req, res);
    case 'generate-team-report': return handleGenerateTeamReport(req, res);
    case 'finalize-report':      return handleFinalizeReport(req, res);
    case 'sign-report-upload':   return handleSignReportUpload(req, res);
    case 'sign-team-report-upload': return handleSignTeamReportUpload(req, res);
    case 'generate-dr-content':  return handleGenerateDRContent(req, res);
    case 'generate-recommendations': return handleGenerateRecommendations(req, res);
    case 'nudge-checkin':        return handleNudgeCheckin(req, res);
    case 'request-external-feedback': return handleRequestExternalFeedback(req, res);
    case 'feedback-context':     return handleFeedbackContext(req, res);
    case 'submit-external-feedback': return handleSubmitExternalFeedback(req, res);
    case 'reminders':            return handleReminders(req, res);
    default:
      return res.status(400).json({ error: `Unknown action: "${action}". Valid: send-invites, schedule-invites, send-scheduled, trial-sweep, send-leader-link, generate-question, generate-g2-question, generate-report, generate-team-report, finalize-report, sign-report-upload, generate-dr-content, request-external-feedback, feedback-context, submit-external-feedback, reminders` });
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
    const cc = (diag.anonymous_feedback ? [] : [diag.client_email]).concat('team@gpsleadership.org').filter(Boolean);
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

  // Close date = exactly 7 days from invite send (overrides any manual close_date)
  const closeDate = new Date(now);
  closeDate.setDate(closeDate.getDate() + 7);
  const closeDateISO  = closeDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const closeDateDisp = closeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

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

    // On an anonymous diagnostic, never CC the leader — doing so reveals the full
    // rater roster to them and shows raters their leader is copied, breaking the
    // anonymity promise. Internal team@ still gets a copy either way.
    const inviteCc = (diag.anonymous_feedback ? [] : [diag.client_email]).concat('team@gpsleadership.org').filter(Boolean);
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

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

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
  const log = { processed: [], skipped: [], errors: [] };

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

    return res.status(200).json({ ok: true, due: due.length, ...log });
  } catch (err) {
    console.error('[diagnostic/send-scheduled] error:', err);
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
        <p style="margin-top:24px;">Once you complete the self-assessment, I'll reach out about next steps — including finalizing the list of people who will provide feedback on your leadership.</p>
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
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

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
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

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

// ── Per-rater-group data builder (Option B) ──────────────────────────────────
function buildRaterGroupData(responses, allRaters) {
  const raterMetaMap = new Map(allRaters.map(r => [r.id, r]));

  // G2/G3 appear in BOTH lists: each custom question is either rated (score
  // rows) or open (text rows) per diagnostics.custom_gX_type — a response row
  // only ever carries one of the two, so dual membership is safe.
  const RATED  = ['A1','A2','A3','A4','A5','A6','A7','B1','B2','B3','B4','B5','B6','C1','C2','C3','C4','C5','C6','D1','F1','F2','G1','G2','G3'];
  const OPEN   = ['A8','A9','A10','B7','B8','B9','B10','C7','C8','C9','D2','F3','G2','G3'];
  const GKEYS  = ['direct_report','peer','supervisor','internal_partner'];

  // Normalize DB relationship values to GKEYS — DB may store title-case ("Peer", "Direct Report")
  // or legacy values ("Manager"). Match case-insensitively, then map to snake_case keys.
  const normalizeRel = (rel) => {
    if (!rel) return null;
    const n = rel.toLowerCase().replace(/[\s\-]+/g, '_');
    if (n === 'manager') return 'supervisor';     // legacy alias
    if (GKEYS.includes(n)) return n;
    // Current taxonomy (leader page, coach bulk import, Excel template):
    // map onto the four report groups; everything else has no group bucket
    // (still counted in All Others via the fallback below).
    const s = n.replace(/[^a-z]/g, '');
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
    self:             mkBucket(),
    all_others:       mkBucket(),
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
    if (resp.rater_id != null) {
      if (key) buckets[key].raterIds.add(resp.rater_id);
      if (!rowIsSelf) buckets.all_others.raterIds.add(resp.rater_id);
    }
    if (resp.score != null && RATED.includes(resp.question_code)) {
      if (key) buckets[key].scores[resp.question_code].push(Number(resp.score));
      if (!rowIsSelf) buckets.all_others.scores[resp.question_code].push(Number(resp.score));
    }
    if (resp.text_response?.trim() && OPEN.includes(resp.question_code)) {
      if (key) buckets[key].verbatims[resp.question_code].push(resp.text_response.trim());
      if (!rowIsSelf) buckets.all_others.verbatims[resp.question_code].push(resp.text_response.trim());
    }
  }

  // Rater counts (n) come from the completed-raters list, not from response
  // rows — anonymous rows carry no rater identity to count distinctly.
  const completedCounts = { direct_report: 0, peer: 0, supervisor: 0, internal_partner: 0, self: 0, all_others: 0 };
  for (const r of allRaters) {
    const k = r.is_self ? 'self' : normalizeRel(r.relationship);
    if (k) completedCounts[k]++;
    if (!r.is_self) completedCounts.all_others++;  // every non-self rater counts here, bucketed or not
  }

  const GROUP_LABELS = {
    direct_report: 'Direct Reports', peer: 'Peers', supervisor: 'Supervisors',
    internal_partner: 'Internal Partners', self: 'Self', all_others: 'All Others',
  };

  const result = {};
  for (const [key, b] of Object.entries(buckets)) {
    const avgScores = {};
    for (const c of RATED) avgScores[c] = avg(b.scores[c]);
    const tAvg  = avg(['A1','A2','A3','A4','A5','A6','A7'].map(c => avgScores[c]).filter(s => s != null));
    const prAvg = avg(['B1','B2','B3','B4','B5','B6'].map(c => avgScores[c]).filter(s => s != null));
    const pdAvg = avg(['C1','C2','C3','C4','C5','C6'].map(c => avgScores[c]).filter(s => s != null));
    result[key] = {
      label:           GROUP_LABELS[key],
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
    };
  }
  return result;
}

// ── Format per-group data for the Claude prompt ──────────────────────────────
function formatRaterGroupDataForPrompt(gd, diag) {
  const GRPS = [
    ['direct_report', 'DR'],
    ['peer', 'Peer'],
    ['supervisor', 'Supr'],
    ['internal_partner', 'IntP'],
    ['self', 'Self'],
    ['all_others', 'All-Oth'],
  ];
  const f = v => (v != null ? v.toFixed(2) : 'n/a');
  const row = (name, key) => {
    const vals = GRPS.map(([g]) => f(gd[g]?.[key]).padStart(5)).join(' | ');
    return `${name.padEnd(22)}| ${vals}`;
  };

  const lines = [];
  lines.push('=== TP3 SCORES BY RATER GROUP (scale 1-5 unless noted) ===');
  lines.push(`\n${'Dimension'.padEnd(22)}| ${'  DR'.padStart(5)} | ${'Peer'.padStart(5)} | ${'Supr'.padStart(5)} | ${'IntP'.padStart(5)} | ${'Self'.padStart(5)} | ${'All-Oth'.padStart(7)}`);
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
      lines.push(`     → ${vals}  (DR | Peer | Supr | IntP | Self | All-Oth)`);
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

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_id,client_name,client_title,client_org,close_date,tier,custom_g1_question,custom_g2_question,custom_g3_question,self_three_year_vision,self_future_self_capabilities,self_immediate_successor_view,self_successor_candidates,self_successor_development_actions,intake_notes,coaching_notes,interview_notes,impact_scale&limit=1`
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
    const groupData = buildRaterGroupData(responses, allRaters);

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

    const coachNotesSection = (diag.intake_notes || diag.coaching_notes || diag.interview_notes)
      ? `\n=== COACH NOTES (CONFIDENTIAL — FOR REPORT CONTEXT ONLY) ===
${diag.intake_notes    ? `Kick-off / Intake Notes:\n${diag.intake_notes}\n`    : ''}${diag.coaching_notes  ? `Coaching Notes:\n${diag.coaching_notes}\n`        : ''}${diag.interview_notes ? `Interview Notes:\n${diag.interview_notes}\n`      : ''}`.trimEnd()
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
      content_json:    { report_format: 'html_v2', generated_with_model: CLAUDE_REPORT_MODEL, rater_groups_used: Object.fromEntries(Object.entries(groupData).map(([k,v]) => [k, v.n])) },
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
        by_group: Object.fromEntries(
          Object.entries(groupData)
            .filter(([k]) => k !== 'all_others')
            .map(([k, v]) => [k, { n: v.n, trust: v.trustAvg, proactivity: v.proactivityAvg, productivity: v.productivityAvg, tp3: v.tp3Index, bench: v.benchAvg }])
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

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });

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
    for (const s of scored) {
      const mm = byClient[s.client_id] || {};
      const report_json = {
        name:           s.name,
        summaryLine:    mm.summaryLine || null,
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
  - target_band: one or more of top|middle|bottom|system, comma-separated if more than one (e.g. "top,middle").
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
    const members = await (await sb(`/rest/v1/team_members?team_id=eq.${team_id}&select=report_json`)).json();
    const memberLines = (Array.isArray(members) ? members : []).map(m => {
      const rj = m.report_json || {};
      return rj.summaryLine ? `- ${rj.name || 'Leader'}: ${rj.summaryLine}` : '';
    }).filter(Boolean);

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
    return res.status(200).json({ ok: true, name: inv.name, by_role: inv.by_role || '', team_name: team.client_org_name || team.name || 'the leadership team', submitted: !!inv.submitted_at });
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
    const openDiagsRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&select=id,client_name,client_email,close_date,anonymous_feedback`);
    const openDiags    = await openDiagsRes.json() || [];

    // Editable templates (only used when coach has approved them; otherwise hardcoded copy stands)
    const r1Tpl = await getApprovedTemplate('diagnostic_reminder_1');
    const r2Tpl = await getApprovedTemplate('diagnostic_reminder_2');

    for (const diag of openDiags) {
      const ratersRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&completed_at=is.null&invited_at=not.is.null&select=id,name,email,token,invited_at,reminder_1_sent_at,reminder_2_sent_at,email_bounced`
      );
      const raters = await ratersRes.json() || [];

      for (const rater of raters) {
        if (rater.email_bounced) continue;
        const daysSinceInvite = daysBetween(new Date(rater.invited_at), now);
        const surveyLink = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;

        const reminderCc = (diag.anonymous_feedback ? [] : [diag.client_email]).concat('team@gpsleadership.org').filter(Boolean);

        const closeFmt = diag.close_date
          ? new Date(diag.close_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : 'soon';
        const firstName = (rater.name || '').split(' ')[0] || 'there';

        if (daysSinceInvite >= 2 && !rater.reminder_1_sent_at) {
          let bodyHtml = null, subjectOverride = null;
          if (r1Tpl) {
            const vars = { first_name: firstName, rater_name: rater.name, leader_name: diag.client_name, close_date: closeFmt, survey_link: surveyLink };
            if (r1Tpl.subject) subjectOverride = fillTemplate(r1Tpl.subject, vars) || null;
            if (r1Tpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(r1Tpl.body_text, vars));
          }
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: false, bodyHtml, subjectOverride });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_1', recipientName: rater.name, cc: reminderCc });
            await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { reminder_1_sent_at: now.toISOString() }, { Prefer: 'return=minimal' });
            log.r1_sent.push({ name: rater.name, diag: diag.client_name });
          } catch (err) {
            log.errors.push({ type: 'R1', name: rater.name, error: err.message });
          }
          continue;
        }

        if (daysSinceInvite >= 5 && rater.reminder_1_sent_at && !rater.reminder_2_sent_at) {
          let bodyHtml = null, subjectOverride = null;
          if (r2Tpl) {
            const vars = { first_name: firstName, rater_name: rater.name, leader_name: diag.client_name, close_date: closeFmt, survey_link: surveyLink };
            if (r2Tpl.subject) subjectOverride = fillTemplate(r2Tpl.subject, vars) || null;
            if (r2Tpl.body_text) bodyHtml = tplBodyToHtml(fillTemplate(r2Tpl.body_text, vars));
          }
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: true, bodyHtml, subjectOverride });
          try {
            await sendEmail({ to: rater.email, ...email, emailType: 'diagnostic_reminder_2', recipientName: rater.name, cc: reminderCc });
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

  lines.push('', 'Generate the full team diagnostic report following the section format above.');
  return lines.join('\n');
}

// ── Import survey data (test/manual data entry) ──────────────────────────────
async function handleImportSurveyData(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { diagnostic_id, raters } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id required' });
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
      `/rest/v1/diagnostics?id=in.(${idFilter})&select=id,client_name,client_title,client_org`
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

      // Others responses (scores + open-ended text)
      let othersResponses = [];
      if (othersRaters?.length > 0) {
        const otherIds = othersRaters.map(r => `"${r.id}"`).join(',');
        const othersRespRes = await sb(
          `/rest/v1/diagnostic_responses?rater_id=in.(${otherIds})&diagnostic_id=eq.${diag.id}&select=rater_id,question_code,score,text_response`
        );
        othersResponses = await othersRespRes.json() || [];
      }

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

      leaders.push({
        name:  diag.client_name,
        title: diag.client_title || '',
        org:   diag.client_org   || '',
        raterCount: (othersRaters || []).length,
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
