// api/ask.js
// Secure proxy for Anthropic API calls — keeps the API key server-side.
// Logs each Ask Alex interaction to ask_alex_log (full text) + ask_alex_usage (counters).

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const PORTAL_ORIGIN   = process.env.PORTAL_BASE_URL || 'https://portal.gpsleadership.org';
const ASK_DAILY_CAP   = 30; // server-side hard cap per client/day (UI shows a softer 20)

// Validate a portal token server-side → returns the client row (or null).
async function getClientByToken(token) {
  if (!token || !SUPABASE_SECRET) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/clients?token=eq.${encodeURIComponent(token)}&is_archived=eq.false&select=id,ask_alex_enabled&limit=1`,
    { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
// Count today's Ask Alex calls for a client (server-side rate limit).
async function countAskToday(clientId) {
  const start = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ask_alex_log?client_id=eq.${clientId}&asked_at=gte.${start}&select=id`,
    { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } });
  if (!r.ok) return 0;
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length : 0;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', PORTAL_ORIGIN);
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
      if (!(await getClientByToken(req.body.token))) return res.status(401).json({ error: 'Invalid or missing token' });

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
      res.setHeader('Access-Control-Allow-Origin', PORTAL_ORIGIN);
      const raw = prefillData?.content?.[0]?.text || '{}';
      const jsonStr = raw.replace(/^```json?\n?/,'').replace(/\n?```$/,'').trim();
      try {
        return res.status(200).json({ prefill: JSON.parse(jsonStr) });
      } catch {
        return res.status(200).json({ prefill: {} });
      }
    }

    const { messages, system, token } = req.body;

    // ── Require a valid portal token + enforce a server-side daily cap ───────
    const askClient = await getClientByToken(token);
    if (!askClient) return res.status(401).json({ error: 'Invalid or missing token' });
    if (askClient.ask_alex_enabled === false) return res.status(403).json({ error: 'Ask Alex is not enabled for your account' });
    if ((await countAskToday(askClient.id)) >= ASK_DAILY_CAP) {
      return res.status(429).json({ error: "You've reached today's question limit. Please try again tomorrow." });
    }

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
    res.setHeader('Access-Control-Allow-Origin', PORTAL_ORIGIN);

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
