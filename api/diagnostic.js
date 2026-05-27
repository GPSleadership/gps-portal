// GPS Leadership Solutions — Diagnostic API (consolidated)
// Routes all diagnostic actions through a single serverless function.
//
// POST /api/diagnostic?action=send-invites      — send rater invite emails
// POST /api/diagnostic?action=generate-question — generate custom G1 question via Claude
// POST /api/diagnostic?action=generate-report   — generate full TP3 report via Claude
// GET|POST /api/diagnostic?action=reminders     — cron: rater reminders + T-2 alerts + auto-lock
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          — Supabase project URL
//   SUPABASE_ANON         — Supabase anon key
//   RESEND_API_KEY        — Resend API key
//   RESEND_FROM_EMAIL     — Sending address (default: noreply@portal.gpsleadership.org)
//   PORTAL_BASE_URL       — Portal base URL (default: https://portal.gpsleadership.org)
//   ANTHROPIC_API_KEY     — Claude API key (required for generate-question + generate-report)
//   COACH_ALERT_EMAIL     — Alert recipient (default: alex@gpsleadership.org)
//   CRON_SECRET           — Optional: protect manual reminders trigger

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON     = process.env.SUPABASE_ANON     || 'sb_publishable_nu9GXGeoqDXcxVocodQ4UA_ke7Yrzyw';
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM       = process.env.RESEND_FROM_EMAIL   || 'noreply@portal.gpsleadership.org';
const PORTAL_BASE       = process.env.PORTAL_BASE_URL     || 'https://portal.gpsleadership.org';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COACH_EMAIL       = process.env.COACH_ALERT_EMAIL   || 'alex@gpsleadership.org';
const CRON_SECRET       = process.env.CRON_SECRET;
const CLAUDE_MODEL      = 'claude-sonnet-4-6';

// ── Supabase fetch helper ────────────────────────────────────────────────────
function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_ANON,
      Authorization:  `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Call Claude API (with retry) ─────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, maxTokens = 512, { retries = 2, retryDelayMs = 3000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[callClaude] retry attempt ${attempt} after ${retryDelayMs}ms…`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
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
async function sendEmail({ to, subject, html, emailType, recipientName, cc }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const payload = { from: `Alex Tremble – GPS Leadership <${RESEND_FROM}>`, to: [to], subject, html };
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
    case 'generate-question':    return handleGenerateQuestion(req, res);
    case 'generate-report':      return handleGenerateReport(req, res);
    case 'generate-team-report': return handleGenerateTeamReport(req, res);
    case 'finalize-report':      return handleFinalizeReport(req, res);
    case 'reminders':            return handleReminders(req, res);
    default:
      return res.status(400).json({ error: `Unknown action: "${action}". Valid: send-invites, generate-question, generate-report, generate-team-report, finalize-report, reminders` });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTION: send-invites
// POST /api/diagnostic?action=send-invites
// Body: { diagnostic_id }
// ═══════════════════════════════════════════════════════════════════════════════

function buildInviteEmail({ raterName, leaderName, leaderTitle, leaderOrg, surveyLink, closeDate }) {
  const firstName  = (raterName || '').split(' ')[0] || 'there';
  const leaderFull = [leaderName, leaderTitle, leaderOrg].filter(Boolean).join(' — ');
  const closeFmt   = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'the survey deadline';

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Leadership Feedback Request</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        <p>Hi ${firstName},</p>
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
        </ul>
        <div style="margin:28px 0;text-align:center;">
          <a href="${surveyLink}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            Complete the Survey →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${surveyLink}" style="color:#1A3D6E;">${surveyLink}</a></p>
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

async function handleSendInvites(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,client_email,close_date,status,self_assessment_completed_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    if (!diag.self_assessment_completed_at) {
      return res.status(400).json({ error: 'Self-assessment not complete. Leader must finish the self-assessment before invites can be sent.' });
    }

    const ratersRes = await sb(
      `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&is_self=eq.false&invited_at=is.null&select=id,name,email,relationship,token`
    );
    const raters = await ratersRes.json();

    if (!Array.isArray(raters) || raters.length === 0) {
      return res.status(200).json({ message: 'No uninvited raters found — all raters may already have been invited.', sent: 0, skipped: 0, errors: [] });
    }

    let sent = 0;
    const errors = [];
    const sentList = [];
    const now = new Date();
    const nowISO = now.toISOString();

    // Close date = exactly 14 days from invite send (overrides any manual close_date)
    const closeDate = new Date(now);
    closeDate.setDate(closeDate.getDate() + 14);
    const closeDateISO  = closeDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const closeDateDisp = closeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    for (const rater of raters) {
      const surveyLink = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;
      const subject    = `Your input is requested — ${diag.client_name} leadership feedback`;
      const html       = buildInviteEmail({
        raterName:   rater.name,
        leaderName:  diag.client_name,
        leaderTitle: diag.client_title,
        leaderOrg:   diag.client_org,
        surveyLink,
        closeDate:   closeDateDisp,
      });

      const inviteCc = [diag.client_email, 'team@gpsleadership.org'].filter(Boolean);
      try {
        await sendEmail({ to: rater.email, subject, html, emailType: 'diagnostic_invite', recipientName: rater.name, cc: inviteCc });
        await sb(`/rest/v1/diagnostic_raters?id=eq.${rater.id}`, 'PATCH', { invited_at: nowISO }, { Prefer: 'return=minimal' });
        sent++;
        sentList.push({ name: rater.name, email: rater.email });
      } catch (err) {
        errors.push({ name: rater.name, email: rater.email, error: err.message });
      }
    }

    if (sent > 0) {
      const updates = {
        invites_sent_at: nowISO,
        start_date:  nowISO.split('T')[0],   // survey opens today
        close_date:  closeDateISO,            // closes 14 days from today
        updated_at:  nowISO,
      };
      if (diag.status !== 'survey_open') updates.status = 'survey_open';
      await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH', updates, { Prefer: 'return=minimal' });
    }

    return res.status(200).json({ message: `Invites sent: ${sent} of ${raters.length}`, sent, sentList, errors });

  } catch (err) {
    console.error('[diagnostic/send-invites] error:', err);
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
2. Be written in third person, starting with "[Leader name]" as a placeholder
3. Evaluate whether current behaviors align with where the leader says they want to go
4. Be answerable from observable behavior, not speculation about intentions
5. Be one sentence, direct, and unambiguous — raters should know exactly what to evaluate
6. Be at the same difficulty level as the other survey questions (not a softball, not a trick)

Format: Return ONLY the question text. No preamble, no explanation, no quotation marks.
Use [Leader] as the placeholder for the leader's name.

Example output (do not copy this — write something specific to the input):
[Leader] demonstrates the leadership behaviors required to transition the business from an operator-led model to a team-led model.`;

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

    const userPrompt = `Leader name: ${diag.client_name}

3-Year Vision:
${diag.self_three_year_vision}

${diag.self_future_self_capabilities ? `Future self / capabilities they want to develop:\n${diag.self_future_self_capabilities}` : ''}

Write the G1 question for this leader.`;

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
  D1: 'Overall leadership impact on the organization (1–10 scale).',
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

function buildScoreSummary(responses) {
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
  const tp3Index          = avg([trustScore, proactivityScore, productivityScore].filter(s => s != null));

  const perQuestion = {};
  for (const [code, scores] of Object.entries(byCode)) {
    perQuestion[code] = { avg: avg(scores), n: scores.length };
  }

  return {
    trustScore, proactivityScore, productivityScore,
    tp3Index, impactScore, benchScore, g1Score,
    perQuestion,
    raterCount: new Set(responses.map(r => r.rater_id)).size,
  };
}

function collectVerbatims(responses) {
  const verbatims = {};
  for (const r of responses) {
    if (!r.text_response?.trim()) continue;
    if (!verbatims[r.question_code]) verbatims[r.question_code] = [];
    verbatims[r.question_code].push(r.text_response.trim());
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
  lines.push(`\nOverall Impact (D1, scale 1-10):\n  D1: ${d1?.avg?.toFixed(2) ?? 'n/a'}/10.0 (n=${d1?.n ?? 0})`);
  lines.push(`\nBench / Succession Readiness (F1-F2, scale 1-5):`);
  lines.push(`  F1: ${perQuestion['F1']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F1']?.avg)}`);
  lines.push(`  F2: ${perQuestion['F2']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F2']?.avg)}`);
  if (scores.g1Score != null) lines.push(`\nCustom Question (G1, scale 1-5): ${scores.g1Score?.toFixed(2) ?? 'n/a'}/5.0`);
  lines.push(`\nSummary:\n  TP3 Index: ${scores.tp3Index?.toFixed(2) ?? 'n/a'}/5.0\n  Overall Impact: ${scores.impactScore?.toFixed(2) ?? 'n/a'}/10.0\n  Total raters (others): ${scores.raterCount}`);
  return lines.join('\n');
}

function formatVerbatimsForPrompt(verbatims) {
  const sections = [
    { label: 'Trust open-ended (A8-A10)', codes: ['A8','A9','A10'] },
    { label: 'Proactivity open-ended (B7-B10)', codes: ['B7','B8','B9','B10'] },
    { label: 'Productivity open-ended (C7-C9)', codes: ['C7','C8','C9'] },
    { label: 'Overall impact comment (D2)', codes: ['D2'] },
    { label: 'Bench / succession comment (F3)', codes: ['F3'] },
  ];
  const lines = [];
  for (const s of sections) {
    const quotes = s.codes.flatMap(c => (verbatims[c] || []).map(v => `  - ${v}`));
    if (quotes.length > 0) { lines.push(`\n${s.label}:`); lines.push(...quotes); }
  }
  return lines.length > 0 ? lines.join('\n') : '\n(No verbatim responses available)';
}

const REPORT_SYSTEM_PROMPT = `You are an expert executive coach and leadership assessment specialist working for GPS Leadership Solutions.

Your job is to generate a structured 14-Day Executive Leadership Diagnostic Report based on quantitative TP3 survey data and verbatim rater feedback.

GPS uses the TP3™ Framework:
- Trust: Do people trust this leader to do what they say?
- Proactivity: Does this leader anticipate and act before being asked?
- Productivity: Does this leader produce high-value output and help others do the same?
- TP3 Index: The combined average across all three dimensions (scale 0–5)
- Overall Impact: A 1–10 direct rating of the leader's impact
- Bench Score: Are they developing the people around them?

Scoring guide (all on 1–5 scale unless noted):
4.5–5.0 = Exceptional | 4.0–4.4 = Strong | 3.5–3.9 = Solid | 3.0–3.4 = Developing | 2.5–2.9 = Needs Attention | <2.5 = Critical Gap

Writing rules:
1. Write directly TO the leader (second person: "you", "your team"). This is THEIR report.
2. Be specific. Quote or closely paraphrase verbatims where they add force. Do not use generic filler.
3. Be honest about gaps. Do not soften a 2.8 into "an area with growth opportunity." Say what it means.
4. Every section should include at least one specific, actionable observation — not just a score summary.
5. The 90-Day Priority section must give the leader exactly 3 prioritized actions, each with: what to do, why it matters now, and how to know it's working.
6. Write like a direct, intelligent executive coach — not an HR consultant.

REQUIRED OUTPUT FORMAT — respond with a valid JSON object and nothing else:
{
  "executive_summary": "string — 3-4 sentences: overall picture, biggest strength, most critical gap, what it means for the business",
  "trust_section": "string — 3-5 sentences on Trust score, standout questions, verbatim insights, what raters need from this leader",
  "proactivity_section": "string — same format for Proactivity",
  "productivity_section": "string — same format for Productivity",
  "impact_section": "string — 2-3 sentences on Overall Impact score + D2 verbatims",
  "bench_section": "string — 2-3 sentences on Bench/Succession readiness + F3 verbatim",
  "custom_section": "string or null — if G1 data available: 2 sentences on the custom question result",
  "succession_section": "string — 2-3 sentences synthesizing the leader's succession response with rater bench data",
  "priorities_90_day": [
    {
      "rank": 1,
      "title": "string — short imperative (e.g., 'Close the commitment gap')",
      "what": "string — specific behavioral change",
      "why": "string — business impact / stakes",
      "signal": "string — how to know it's working in 90 days"
    },
    { "rank": 2 },
    { "rank": 3 }
  ],
  "full_narrative": "string — full HTML report body (~600-900 words). Use <h2>, <p>, <ul> tags. No inline styles. This is for direct display in the coach portal."
}`;

async function handleGenerateReport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) return res.status(400).json({ error: 'diagnostic_id is required' });

  try {
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,close_date,tier,custom_g1_question,self_three_year_vision,self_future_self_capabilities,self_immediate_successor_view,self_successor_candidates,self_successor_development_actions,intake_notes,coaching_notes,interview_notes&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) return res.status(404).json({ error: 'Diagnostic not found' });
    const diag = diags[0];

    const ratersRes = await sb(
      `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&is_self=eq.false&completed_at=not.is.null&select=id`
    );
    const raters = await ratersRes.json();
    if (!Array.isArray(raters) || raters.length === 0) {
      return res.status(400).json({ error: 'No completed rater responses found. Survey must be closed before generating a report.' });
    }
    const raterIds = raters.map(r => r.id);

    const raterIdFilter = raterIds.map(id => `"${id}"`).join(',');
    const respRes = await sb(
      `/rest/v1/diagnostic_responses?rater_id=in.(${raterIdFilter})&diagnostic_id=eq.${diagnostic_id}&select=rater_id,question_code,score,text_response`
    );
    const responses = await respRes.json();
    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ error: 'No responses found for this diagnostic.' });
    }

    const overridesRes = await sb(
      `/rest/v1/diagnostic_question_overrides?diagnostic_id=eq.${diagnostic_id}&select=question_code,override_text`
    );
    const overrides    = await overridesRes.json() || [];
    const overrideMap  = Object.fromEntries(overrides.map(o => [o.question_code, o.override_text]));

    const scores    = buildScoreSummary(responses);
    const verbatims = collectVerbatims(responses);

    const versionsRes = await sb(
      `/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${diagnostic_id}&select=version&order=version.desc&limit=1`
    );
    const versions    = await versionsRes.json();
    const latestVersion = versions?.[0]?.version || 0;
    const nextVersion   = latestVersion + 1;

    // ── Cost ceiling: max 5 report generations per diagnostic ────────────
    const MAX_REPORT_DRAFTS = 5;
    if (latestVersion >= MAX_REPORT_DRAFTS) {
      return res.status(429).json({
        error: `Report generation limit reached (${MAX_REPORT_DRAFTS} drafts maximum). Contact support if you need to regenerate.`,
        draft_count: latestVersion,
      });
    }

    const overrideNotes = Object.keys(overrideMap).length > 0
      ? `\nNote — question overrides in effect: ${Object.entries(overrideMap).map(([k,v]) => `${k}: "${v}"`).join('; ')}`
      : '';

    const coachNotesSection = (diag.intake_notes || diag.coaching_notes || diag.interview_notes)
      ? `\n=== COACH NOTES (CONFIDENTIAL — FOR REPORT CONTEXT ONLY) ===
${diag.intake_notes      ? `Kick-off / Intake Notes:\n${diag.intake_notes}\n`      : ''}${diag.coaching_notes    ? `Coaching Notes:\n${diag.coaching_notes}\n`          : ''}${diag.interview_notes   ? `Interview Notes:\n${diag.interview_notes}\n`        : ''}`.trimEnd()
      : '';

    const userPrompt = `
LEADER: ${diag.client_name}${diag.client_title ? `, ${diag.client_title}` : ''}${diag.client_org ? ` — ${diag.client_org}` : ''}
DIAGNOSTIC TIER: ${diag.tier || 'standard'}

=== QUANTITATIVE SCORES ===
${formatScoresForPrompt(scores)}${overrideNotes}

=== VERBATIM RESPONSES ===
${formatVerbatimsForPrompt(verbatims)}

=== SELF-ASSESSMENT — SUCCESSION & FUTURE SELF (LEADER ONLY, CONFIDENTIAL TO REPORT) ===
3-Year Vision: ${diag.self_three_year_vision || 'Not provided'}
Future self / capabilities: ${diag.self_future_self_capabilities || 'Not provided'}
Immediate successor view: ${diag.self_immediate_successor_view || 'Not provided'}
Successor candidates: ${diag.self_successor_candidates || 'Not provided'}
Successor development actions: ${diag.self_successor_development_actions || 'Not provided'}
${diag.custom_g1_question ? `\nCustom G1 Question (used in survey): "${diag.custom_g1_question}"` : ''}${coachNotesSection}

Generate the diagnostic report JSON now.`.trim();

    const raw = await callClaude(REPORT_SYSTEM_PROMPT, userPrompt, 8192);

    let reportJson;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      reportJson = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[diagnostic/generate-report] JSON parse error. Raw output:\n', raw.slice(0, 500));
      return res.status(500).json({ error: 'Claude returned malformed JSON.', raw: raw.slice(0, 1000) });
    }

    const now = new Date().toISOString();
    const draftRes = await sb('/rest/v1/diagnostic_report_drafts', 'POST', {
      diagnostic_id,
      version:      nextVersion,
      content_json: reportJson,
      scores_json: {
        trust:        scores.trustScore,
        proactivity:  scores.proactivityScore,
        productivity: scores.productivityScore,
        tp3_index:    scores.tp3Index,
        impact:       scores.impactScore,
        bench:        scores.benchScore,
        g1:           scores.g1Score,
        rater_count:  scores.raterCount,
        per_question: scores.perQuestion,
      },
      generated_at: now,
    }, { Prefer: 'return=representation' });
    const drafts = await draftRes.json();
    const draft  = Array.isArray(drafts) ? drafts[0] : drafts;

    await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}`, 'PATCH',
      { status: 'report_draft', report_generated_at: now, updated_at: now },
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

function buildReportReadyEmail({ clientName, leaderTitle, leaderOrg, portalUrl }) {
  const firstName = (clientName || '').split(' ')[0] || 'there';
  const orgLine   = [leaderTitle, leaderOrg].filter(Boolean).join(' — ');

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
        <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;">Your Leadership Report Is Ready</div>
      </div>
      <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
        <p>Hi ${firstName},</p>
        <p>Your GPS Leadership Diagnostic report has been finalized${orgLine ? ` for <strong>${orgLine}</strong>` : ''}.</p>
        <p>Your results — including your TP3™ breakdown, rater feedback themes, and 90-day priorities — are now available in your portal.</p>
        <div style="margin:28px 0;text-align:center;">
          <a href="${portalUrl}"
             style="background:#1A3D6E;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;">
            View My Report →
          </a>
        </div>
        <p style="font-size:13px;color:#666;">Or copy this link: <a href="${portalUrl}" style="color:#1A3D6E;">${portalUrl}</a></p>
        <p style="margin-top:24px;">We'll use your next session to walk through the findings and build your action plan.</p>
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
    const emailHtml = buildReportReadyEmail({
      clientName:  client.name,
      leaderTitle: client.title || null,
      leaderOrg:   client.organization || null,
      portalUrl,
    });

    let emailId = null;
    try {
      emailId = await sendEmail({
        to:            client.email,
        subject:       'Your GPS Leadership Report Is Ready',
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
// Auth: x-vercel-cron header, Bearer CRON_SECRET, or { manual_trigger: true }
// ═══════════════════════════════════════════════════════════════════════════════

function daysBetween(earlier, later) {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / (1000 * 60 * 60 * 24);
}

function daysFromNow(dateStr) {
  return daysBetween(new Date(), new Date(dateStr + 'T12:00:00'));
}

function buildReminderEmail({ raterName, leaderName, surveyLink, closeDate, isSecond }) {
  const firstName = (raterName || '').split(' ')[0] || 'there';
  const closeFmt  = closeDate
    ? new Date(closeDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : 'soon';
  const urgency = isSecond
    ? `<p><strong>The survey closes ${closeFmt}.</strong> This is your last reminder.</p>`
    : `<p>The survey closes on <strong>${closeFmt}</strong> — there's still time.</p>`;

  return {
    subject: isSecond ? `Last reminder — ${leaderName} leadership feedback` : `Quick reminder — ${leaderName} leadership feedback`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1A3D6E;padding:20px 28px;border-radius:8px 8px 0 0;">
          <div style="color:#C09A2A;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">GPS Leadership Solutions</div>
          <div style="color:#ffffff;font-size:20px;font-weight:700;">${isSecond ? 'Final Reminder — ' : ''}Leadership Feedback Request</div>
        </div>
        <div style="background:#ffffff;padding:28px;border-radius:0 0 8px 8px;border:1px solid #d0d0d0;border-top:none;line-height:1.7;font-size:15px;">
          <p>Hi ${firstName},</p>
          <p>A quick follow-up — you haven't yet completed the feedback survey for <strong>${leaderName}</strong>.</p>
          ${urgency}
          <p>It takes 15–20 minutes. Your responses are confidential — individual answers are never shared.</p>
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

async function handleReminders(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron    = req.headers['x-vercel-cron'] === '1';
  const isManualTrigger = req.method === 'POST' && req.body?.manual_trigger === true;
  const authHeader      = req.headers['authorization'] || '';
  const hasSecret       = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualTrigger && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = { r1_sent: [], r2_sent: [], t2_alerts: [], plans_locked: [], delivery_alert: null, errors: [] };
  const now = new Date();

  try {
    // ── Section 1: Rater Reminders (R1 + R2) ────────────────────────────────
    const openDiagsRes = await sb(`/rest/v1/diagnostics?status=eq.survey_open&select=id,client_name,client_email,close_date`);
    const openDiags    = await openDiagsRes.json() || [];

    for (const diag of openDiags) {
      const ratersRes = await sb(
        `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diag.id}&is_self=eq.false&completed_at=is.null&invited_at=not.is.null&select=id,name,email,token,invited_at,reminder_1_sent_at,reminder_2_sent_at,email_bounced`
      );
      const raters = await ratersRes.json() || [];

      for (const rater of raters) {
        if (rater.email_bounced) continue;
        const daysSinceInvite = daysBetween(new Date(rater.invited_at), now);
        const surveyLink = `${PORTAL_BASE}/diagnostic-survey?token=${rater.token}`;

        const reminderCc = [diag.client_email, 'team@gpsleadership.org'].filter(Boolean);

        if (daysSinceInvite >= 2 && !rater.reminder_1_sent_at) {
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: false });
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
          const email = buildReminderEmail({ raterName: rater.name, leaderName: diag.client_name, surveyLink, closeDate: diag.close_date, isSecond: true });
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

    return res.status(200).json({
      ran_at:         now.toISOString(),
      r1_sent:        log.r1_sent.length,
      r2_sent:        log.r2_sent.length,
      t2_alerts:      log.t2_alerts.length,
      plans_locked:   log.plans_locked.length,
      delivery_alert: log.delivery_alert,
      details:        log,
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

function buildTeamReportPrompt({ org_name, team_name, prepared_for_name, prepared_for_title, assessment_date_range, sector_type, leaders, total_raters, verbatims }) {
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

  for (const l of leaders) {
    lines.push('');
    lines.push(`Leader: ${l.name}${l.title ? `, ${l.title}` : ''}${l.org ? ` (${l.org})` : ''}`);
    lines.push(`  Others who completed survey: ${l.raterCount}`);
    lines.push(`  TRUST (A1–A7, 1–5 scale):       Self ${fmt(l.selfScores.trust)}  | Others ${fmt(l.othersScores.trust)}  | Gap ${gap(l.selfScores.trust, l.othersScores.trust)}`);
    lines.push(`  PROACTIVITY (B1–B6, 1–5):        Self ${fmt(l.selfScores.proactivity)}  | Others ${fmt(l.othersScores.proactivity)}  | Gap ${gap(l.selfScores.proactivity, l.othersScores.proactivity)}`);
    lines.push(`  PRODUCTIVITY (C1–C6, 1–5):       Self ${fmt(l.selfScores.productivity)}  | Others ${fmt(l.othersScores.productivity)}  | Gap ${gap(l.selfScores.productivity, l.othersScores.productivity)}`);
    lines.push(`  TP3 Index (others avg, 1–5):     ${fmt(l.othersScores.tp3)} — ${label(l.othersScores.tp3)}`);
    lines.push(`  Overall Impact D1 (1–10 scale):  Self ${l.selfScores.impact != null ? l.selfScores.impact.toFixed(1) : 'n/a'} | Others ${l.othersScores.impact != null ? l.othersScores.impact.toFixed(2) : 'n/a'}`);
    lines.push(`  Bench / Succession (F1–F2, 1–5): Others ${fmt(l.othersScores.bench)}`);
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
  lines.push(`  Impact D1 avg:      ${fmt(teamIm)}/10.0`);
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

async function handleGenerateTeamReport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { diagnostic_ids, org_name, team_name, prepared_for_name, prepared_for_title, assessment_date_range, sector_type } = req.body || {};

  if (!Array.isArray(diagnostic_ids) || diagnostic_ids.length < 2) {
    return res.status(400).json({ error: 'At least 2 diagnostic_ids are required for a team report.' });
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
    if (!Array.isArray(diags) || diags.length < 2) {
      return res.status(400).json({ error: 'Could not find at least 2 valid diagnostics for the provided IDs.' });
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
    });

    const reportText = await callClaude(TEAM_REPORT_SYSTEM_PROMPT, userPrompt, 8192);
    if (!reportText) return res.status(500).json({ error: 'Claude returned an empty response.' });

    // ── 4. Store in Supabase ───────────────────────────────────────────────────
    const now = new Date().toISOString();
    await sb('/rest/v1/diagnostic_team_reports', 'POST', {
      org_name:              org_name   || '',
      team_name:             team_name  || '',
      prepared_for_name:     prepared_for_name  || '',
      prepared_for_title:    prepared_for_title || '',
      assessment_date_range: assessment_date_range || '',
      sector_type:           sector_type || 'private',
      diagnostic_ids:        JSON.stringify(diagnostic_ids),
      num_leaders:           leaders.length,
      total_raters:          totalRaters,
      content_text:          reportText,
      generated_at:          now,
      updated_at:            now,
    }, { Prefer: 'return=minimal' });

    return res.status(200).json({
      report:       reportText,
      num_leaders:  leaders.length,
      total_raters: totalRaters,
      generated_at: now,
    });

  } catch (err) {
    console.error('[diagnostic/generate-team-report] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
