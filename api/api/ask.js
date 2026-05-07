// api/ask.js
// Secure proxy for Anthropic API calls — keeps the API key server-side.
// Also logs each Ask Alex interaction to ask_alex_usage and updates client counters.

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages
      })
    });

    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ── Log usage (fire-and-forget — never blocks the AI response) ──────────
    if (response.ok && token && SUPABASE_SECRET) {
      const questionLength = Array.isArray(messages) && messages.length > 0
        ? (messages[messages.length - 1]?.content || '').length
        : 0;
      logUsage(token, questionLength).catch(() => {});
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Log to ask_alex_usage + update client counters ───────────────────────────
async function logUsage(token, questionLength) {
  // 1. Look up client by token
  const clientRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clients?token=eq.${encodeURIComponent(token)}&select=id`,
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
  const clientId = clients[0].id;

  const now = new Date().toISOString();

  // 2. Insert usage row
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

  // 3. Increment total_questions and set last_used_at using Postgres RPC
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
