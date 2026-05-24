// GPS Leadership Solutions — Generate Diagnostic Report
// POST /api/generate-diagnostic-report
// Body: { diagnostic_id }
//
// What it does:
//   1. Fetches all rater responses (is_self=false) for the diagnostic
//   2. Computes TP3 scores: Trust (A1-A7), Proactivity (B1-B6), Productivity (C1-C6)
//   3. Computes TP3 Index, Overall Impact (D1), Bench scores (F1-F2)
//   4. Aggregates per-question averages and verbatim open-ended responses
//   5. Fetches self-assessment succession responses (Section E from diagnostics table)
//   6. Fetches question overrides (if any)
//   7. Calls Claude API (claude-sonnet-4-6) to generate a structured report
//   8. Saves a new version to diagnostic_report_drafts
//   9. Updates diagnostic.status = 'report_draft', report_generated_at = now()
//
// TP3 Framework:
//   Trust Score     = avg(A1–A7) — others only
//   Proactivity     = avg(B1–B6) — others only
//   Productivity    = avg(C1–C6) — others only
//   TP3 Index       = (Trust + Proactivity + Productivity) / 3
//   Overall Impact  = avg(D1)    — others only (1–10 scale)
//   Bench Score     = avg(F1–F2) — others only
//
// Called from: diagnostic-coach.html → generateReport()
//
// ENV VARS REQUIRED:
//   ANTHROPIC_API_KEY  — Claude API key
//   SUPABASE_URL       — Supabase project URL
//   SUPABASE_ANON      — Supabase anon key

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON     = process.env.SUPABASE_ANON     || 'sb_publishable_nu9GXGeoqDXcxVocodQ4UA_ke7Yrzyw';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL      = 'claude-sonnet-4-6';

// ── Question bank — TP3 V2 ───────────────────────────────────────────────────
const QUESTIONS = {
  A1: 'Does what they say they will do.',
  A2: 'Is honest and transparent in their communication.',
  A3: 'Follows through on commitments, even when it\'s difficult.',
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
  A9:  'When has this leader\'s honesty or transparency made a difference?',
  A10: 'What one change in this leader\'s behavior would most increase trust?',
  B7:  'Describe a situation where this leader was proactive in a meaningful way.',
  B8:  'Where does this leader\'s lack of proactivity create problems for the team?',
  B9:  'What would being more proactive look like for this leader in their current role?',
  B10: 'What one thing could this leader start doing to be more proactive?',
  C7:  'How does this leader\'s use of time affect the people around them?',
  C8:  'What is one thing this leader does that wastes time — for themselves or the team?',
  C9:  'What would "more productive" look like for this leader in practice?',
  D2:  'What is the single most important change this leader could make to increase their impact?',
  F3:  'What is the biggest barrier to this leader building a stronger bench around them?',
};

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

// ── Call Claude API ──────────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 8192,
      system:     systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

// ── Score helpers ────────────────────────────────────────────────────────────
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

// ── Build score summary ──────────────────────────────────────────────────────
function buildScoreSummary(responses, customG1Question) {
  // Group scores by question_code (others only — is_self filtered before calling)
  const byCode = {};
  for (const r of responses) {
    if (r.score == null) continue;
    if (!byCode[r.question_code]) byCode[r.question_code] = [];
    byCode[r.question_code].push(Number(r.score));
  }

  const qAvg = (codes) => avg(codes.flatMap(c => byCode[c] || []));

  const trustScore       = qAvg(['A1','A2','A3','A4','A5','A6','A7']);
  const proactivityScore = qAvg(['B1','B2','B3','B4','B5','B6']);
  const productivityScore= qAvg(['C1','C2','C3','C4','C5','C6']);
  const impactScore      = qAvg(['D1']); // 1–10 scale
  const benchScore       = qAvg(['F1','F2']);
  const g1Score          = qAvg(['G1']);

  const tp3Index = avg([trustScore, proactivityScore, productivityScore].filter(s => s != null));

  // Per-question averages
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

// ── Collect verbatims ────────────────────────────────────────────────────────
function collectVerbatims(responses) {
  const verbatims = {};
  for (const r of responses) {
    if (!r.text_response?.trim()) continue;
    if (!verbatims[r.question_code]) verbatims[r.question_code] = [];
    verbatims[r.question_code].push(r.text_response.trim());
  }
  return verbatims;
}

// ── Format scores for prompt ─────────────────────────────────────────────────
function formatScoresForPrompt(scores, perQuestion) {
  const lines = [];
  const section = (codes, name) => {
    const avgs = codes.map(c => {
      const q = perQuestion[c];
      return q ? `  ${c}: ${q.avg?.toFixed(2) ?? 'n/a'}/5.0 (n=${q.n})` : `  ${c}: no data`;
    });
    lines.push(`\n${name}:`);
    lines.push(...avgs);
  };

  section(['A1','A2','A3','A4','A5','A6','A7'], 'Trust (A1-A7, scale 1-5)');
  lines.push(`  → Trust Score: ${scores.trustScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.trustScore)}`);

  section(['B1','B2','B3','B4','B5','B6'], 'Proactivity (B1-B6, scale 1-5)');
  lines.push(`  → Proactivity Score: ${scores.proactivityScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.proactivityScore)}`);

  section(['C1','C2','C3','C4','C5','C6'], 'Productivity (C1-C6, scale 1-5)');
  lines.push(`  → Productivity Score: ${scores.productivityScore?.toFixed(2) ?? 'n/a'}/5.0 — ${label(scores.productivityScore)}`);

  lines.push(`\nOverall Impact (D1, scale 1-10):`);
  const d1 = perQuestion['D1'];
  lines.push(`  D1: ${d1?.avg?.toFixed(2) ?? 'n/a'}/10.0 (n=${d1?.n ?? 0})`);

  lines.push(`\nBench / Succession Readiness (F1-F2, scale 1-5):`);
  lines.push(`  F1: ${perQuestion['F1']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F1']?.avg)}`);
  lines.push(`  F2: ${perQuestion['F2']?.avg?.toFixed(2) ?? 'n/a'}/5.0 — ${label(perQuestion['F2']?.avg)}`);

  if (scores.g1Score != null) {
    lines.push(`\nCustom Question (G1, scale 1-5): ${scores.g1Score?.toFixed(2) ?? 'n/a'}/5.0`);
  }

  lines.push(`\nSummary:`);
  lines.push(`  TP3 Index: ${scores.tp3Index?.toFixed(2) ?? 'n/a'}/5.0`);
  lines.push(`  Overall Impact: ${scores.impactScore?.toFixed(2) ?? 'n/a'}/10.0`);
  lines.push(`  Total raters (others): ${scores.raterCount}`);

  return lines.join('\n');
}

// ── Format verbatims for prompt ──────────────────────────────────────────────
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
    if (quotes.length > 0) {
      lines.push(`\n${s.label}:`);
      lines.push(...quotes);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '\n(No verbatim responses available)';
}

// ── System prompt for report generation ─────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert executive coach and leadership assessment specialist working for GPS Leadership Solutions.

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
    { "rank": 2, ... },
    { "rank": 3, ... }
  ],
  "full_narrative": "string — full HTML report body (~600-900 words). Use <h2>, <p>, <ul> tags. No inline styles. This is for direct display in the coach portal."
}`;

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { diagnostic_id } = req.body || {};
  if (!diagnostic_id) {
    return res.status(400).json({ error: 'diagnostic_id is required' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  try {
    // ── 1. Fetch diagnostic ────────────────────────────────────────────────
    const diagRes = await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,client_title,client_org,close_date,tier,custom_g1_question,self_three_year_vision,self_future_self_capabilities,self_immediate_successor_view,self_successor_candidates,self_successor_development_actions&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) {
      return res.status(404).json({ error: 'Diagnostic not found' });
    }
    const diag = diags[0];

    // ── 2. Fetch all rater IDs (others only, completed) ────────────────────
    const ratersRes = await sb(
      `/rest/v1/diagnostic_raters?diagnostic_id=eq.${diagnostic_id}&is_self=eq.false&completed_at=not.is.null&select=id`
    );
    const raters = await ratersRes.json();
    if (!Array.isArray(raters) || raters.length === 0) {
      return res.status(400).json({
        error: 'No completed rater responses found. Survey must be closed before generating a report.',
      });
    }
    const raterIds = raters.map(r => r.id);

    // ── 3. Fetch all responses for those raters ────────────────────────────
    const raterIdFilter = raterIds.map(id => `"${id}"`).join(',');
    const respRes = await sb(
      `/rest/v1/diagnostic_responses?rater_id=in.(${raterIdFilter})&diagnostic_id=eq.${diagnostic_id}&select=rater_id,question_code,score,text_response`
    );
    const responses = await respRes.json();

    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ error: 'No responses found for this diagnostic.' });
    }

    // ── 4. Fetch question overrides ────────────────────────────────────────
    const overridesRes = await sb(
      `/rest/v1/diagnostic_question_overrides?diagnostic_id=eq.${diagnostic_id}&select=question_code,override_text`
    );
    const overrides = await overridesRes.json() || [];
    const overrideMap = Object.fromEntries((overrides).map(o => [o.question_code, o.override_text]));

    // ── 5. Compute scores and verbatims ────────────────────────────────────
    const scores    = buildScoreSummary(responses, diag.custom_g1_question);
    const verbatims = collectVerbatims(responses);

    // ── 6. Get current version number ─────────────────────────────────────
    const versionsRes = await sb(
      `/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${diagnostic_id}&select=version&order=version.desc&limit=1`
    );
    const versions = await versionsRes.json();
    const nextVersion = (versions?.[0]?.version || 0) + 1;

    // ── 7. Build Claude prompt ─────────────────────────────────────────────
    const overrideNotes = Object.keys(overrideMap).length > 0
      ? `\nNote — question overrides in effect: ${Object.entries(overrideMap).map(([k,v]) => `${k}: "${v}"`).join('; ')}`
      : '';

    const userPrompt = `
LEADER: ${diag.client_name}${diag.client_title ? `, ${diag.client_title}` : ''}${diag.client_org ? ` — ${diag.client_org}` : ''}
DIAGNOSTIC TIER: ${diag.tier || 'standard'}

=== QUANTITATIVE SCORES ===
${formatScoresForPrompt(scores, scores.perQuestion)}${overrideNotes}

=== VERBATIM RESPONSES ===
${formatVerbatimsForPrompt(verbatims)}

=== SELF-ASSESSMENT — SUCCESSION & FUTURE SELF (LEADER ONLY, CONFIDENTIAL TO REPORT) ===
3-Year Vision: ${diag.self_three_year_vision || 'Not provided'}
Future self / capabilities: ${diag.self_future_self_capabilities || 'Not provided'}
Immediate successor view: ${diag.self_immediate_successor_view || 'Not provided'}
Successor candidates: ${diag.self_successor_candidates || 'Not provided'}
Successor development actions: ${diag.self_successor_development_actions || 'Not provided'}
${diag.custom_g1_question ? `\nCustom G1 Question (used in survey): "${diag.custom_g1_question}"` : ''}

Generate the diagnostic report JSON now.`.trim();

    // ── 8. Call Claude ─────────────────────────────────────────────────────
    const raw = await callClaude(SYSTEM_PROMPT, userPrompt);

    // Parse the JSON response
    let reportJson;
    try {
      // Strip markdown code fences if Claude wrapped the output
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      reportJson = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[generate-diagnostic-report] JSON parse error. Raw output:\n', raw.slice(0, 500));
      return res.status(500).json({
        error: 'Claude returned malformed JSON. Review raw output.',
        raw: raw.slice(0, 1000),
      });
    }

    // ── 9. Save report draft ───────────────────────────────────────────────
    const now = new Date().toISOString();
    const draftRes = await sb(
      '/rest/v1/diagnostic_report_drafts',
      'POST',
      {
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
      },
      { Prefer: 'return=representation' }
    );
    const drafts = await draftRes.json();
    const draft  = Array.isArray(drafts) ? drafts[0] : drafts;

    // ── 10. Update diagnostic status ───────────────────────────────────────
    await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}`,
      'PATCH',
      {
        status:               'report_draft',
        report_generated_at:  now,
        updated_at:           now,
      },
      { Prefer: 'return=minimal' }
    );

    return res.status(200).json({
      draft_id:    draft?.id,
      version:     nextVersion,
      scores: {
        trust:       scores.trustScore,
        proactivity: scores.proactivityScore,
        productivity:scores.productivityScore,
        tp3_index:   scores.tp3Index,
        impact:      scores.impactScore,
        bench:       scores.benchScore,
        rater_count: scores.raterCount,
      },
      generated_at: now,
    });

  } catch (err) {
    console.error('[generate-diagnostic-report] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
