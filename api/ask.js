// api/ask.js
// Secure proxy for Anthropic API calls — keeps the API key server-side.
// Logs each Ask Alex interaction to ask_alex_log (full text) + ask_alex_usage (counters).

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── Wizard goal-prefill route ──────────────────────────────────────────
    if (req.body.action === 'prefill') {
      const { goal90, goal30, pillar } = req.body;
      if (!goal90) return res.status(400).json({ error: 'goal90 required' });

      const prefillPrompt = `You are helping a leader build a 90-day leadership development plan. All suggestions must be written in FIRST PERSON using "I" — never "you" or "they".

Focus pillar: ${pillar || 'not specified'}
90-day goal: ${goal90}
30-day goal: ${goal30 || '(not provided)'}

Generate concrete, specific suggestions. Return ONLY valid JSON — no markdown, no explanation.

{
  "behavior1": "First-person action statement, e.g. 'I will hold weekly 1:1s where I ask for solutions before offering mine'",
  "behavior2": "A second distinct first-person behavior, different domain from behavior1",
  "metric1Name": "Count-based metric: '# of times I [specific behavior] this week' — tied directly to behavior1",
  "metric2Question": "A stakeholder perception question rated 1-10, e.g. 'On a scale of 1-10, to what degree does [Name] delegate decisions to the right level?'",
  "goal30": "First-person 30-day checkpoint starting with 'By day 30, I will have...' — a specific observable fact proving early progress. Use empty string if the provided 30-day goal is already solid."
}`;

      const prefillResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prefillPrompt }]
        })
      });

      const prefillData = await prefillResp.json();
      res.setHeader('Access-Control-Allow-Origin', '*');
      const raw = prefillData?.content?.[0]?.text || '{}';
      const jsonStr = raw.replace(/^```json?\n?/,'').replace(/\n?```$/,'').trim();
      try {
        return res.status(200).json({ prefill: JSON.parse(jsonStr) });
      } catch {
        return res.status(200).json({ prefill: {} });
      }
    }

    const { messages, system, token } = req.body;

    // ── Call Anthropic ──────────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system,
        messages
      })
    });

    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ── Log usage (awaited so Vercel doesn't kill the function before it runs) ──
    if (response.ok && token && SUPABASE_SECRET) {
      // Extract question text: last user-role message in the array
      const lastUserMsg = Array.isArray(messages)
        ? [...messages].reverse().find(m => m.role === 'user')
        : null;
      const questionText   = lastUserMsg?.content || '';
      const questionLength = questionText.length;

      // Extract response text + token counts from Anthropic response
      const responseText  = data?.content?.[0]?.text || '';
      const inputTokens   = data?.usage?.input_tokens  || null;
      const outputTokens  = data?.usage?.output_tokens || null;

      await logUsage(token, questionText, questionLength, responseText, inputTokens, outputTokens).catch(() => {});
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Log to ask_alex_log (full text) + ask_alex_usage (counters) ─────────────
async function logUsage(token, questionText, questionLength, responseText, inputTokens, outputTokens) {
  // 1. Look up client by token (also fetch current_sprint for context)
  const clientRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?token=eq.${encodeURIComponent(token)}&select=id,current_sprint_number`,
    {
      headers: {
        apikey: SUPABASE_SECRET,
        Authorization: `Bearer ${SUPABASE_SECRET}`,
      }
    }
  );
  if (!clientRes.ok) return;
  const clients = await clientRes.json();
  if (!clients || clients.length === 0) return;
  const clientId     = clients[0].id;
  const sprintNumber = clients[0].current_sprint_number || null;

  const now = new Date().toISOString();

  // 2. Insert full-text log row into ask_alex_log
  await fetch(`${SUPABASE_URL}/rest/v1/ask_alex_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      client_id:     clientId,
      asked_at:      now,
      question_text: questionText  || null,
      response_text: responseText  || null,
      sprint_number: sprintNumber,
      input_tokens:  inputTokens   || null,
      output_tokens: outputTokens  || null,
    })
  });

  // 3. Insert legacy usage row (question_length counter — kept for backward compat)
  await fetch(`${SUPABASE_URL}/rest/v1/ask_alex_usage`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      client_id:       clientId,
      asked_at:        now,
      question_length: questionLength || null,
    })
  });

  // 4. Atomic increment on client counters (total_questions, last_used_at)
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_ask_alex`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_client_id: clientId, p_asked_at: now })
  });
}
