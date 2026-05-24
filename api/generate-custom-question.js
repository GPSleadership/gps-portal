// GPS Leadership Solutions — Generate Custom G1 Diagnostic Question
// POST /api/generate-custom-question
// Body: { diagnostic_id }
//
// What it does:
//   1. Fetches the leader's self_three_year_vision + self_future_self_capabilities
//      from the diagnostics table
//   2. Calls Claude API (claude-sonnet-4-6) to generate a personalized Section G, G1 question
//   3. Saves the question to diagnostics.custom_g1_question + custom_g1_generated_at
//   4. Returns the generated question
//
// The G1 question is a custom behavioral/leadership question that raters answer
// on a 1–5 scale. It's specific to the leader's stated 3-year vision so raters
// can evaluate whether current behaviors align with that direction.
//
// Called from: diagnostic-coach.html → generateG1()
//
// ENV VARS REQUIRED:
//   ANTHROPIC_API_KEY  — Claude API key
//   SUPABASE_URL       — Supabase project URL
//   SUPABASE_ANON      — Supabase anon key

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON     = process.env.SUPABASE_ANON     || 'sb_publishable_nu9GXGeoqDXcxVocodQ4UA_ke7Yrzyw';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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
      max_tokens: 512,
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

// ── System prompt for G1 generation ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are an executive leadership assessment specialist working for GPS Leadership Solutions.

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
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=id,client_name,self_three_year_vision,self_future_self_capabilities,self_assessment_completed_at&limit=1`
    );
    const diags = await diagRes.json();
    if (!Array.isArray(diags) || diags.length === 0) {
      return res.status(404).json({ error: 'Diagnostic not found' });
    }
    const diag = diags[0];

    if (!diag.self_three_year_vision) {
      return res.status(400).json({
        error: 'Leader has not completed the self-assessment. self_three_year_vision is required to generate G1.',
      });
    }

    // ── 2. Build prompt ────────────────────────────────────────────────────
    const userPrompt = `Leader name: ${diag.client_name}

3-Year Vision:
${diag.self_three_year_vision}

${diag.self_future_self_capabilities
  ? `Future self / capabilities they want to develop:\n${diag.self_future_self_capabilities}`
  : ''}

Write the G1 question for this leader.`;

    // ── 3. Call Claude ─────────────────────────────────────────────────────
    const question = await callClaude(SYSTEM_PROMPT, userPrompt);

    if (!question) {
      return res.status(500).json({ error: 'Claude returned an empty response' });
    }

    // ── 4. Save to diagnostics ─────────────────────────────────────────────
    const now = new Date().toISOString();
    await sb(
      `/rest/v1/diagnostics?id=eq.${diagnostic_id}`,
      'PATCH',
      {
        custom_g1_question:      question,
        custom_g1_generated_at:  now,
        updated_at:              now,
      },
      { Prefer: 'return=minimal' }
    );

    return res.status(200).json({
      question,
      generated_at: now,
    });

  } catch (err) {
    console.error('[generate-custom-question] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
