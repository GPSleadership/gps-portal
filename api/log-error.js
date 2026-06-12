// api/log-error.js — browser error beacon (P1 #8).
// client.html / coach.html report uncaught JS errors here so they land in
// client_errors instead of dying in a client's console where nobody sees them.
//
// Deliberately unauthenticated: a broken page can't be relied on to have a
// valid session, and the whole point is catching errors. Abuse is bounded by
// hard field caps and a small per-request allowance; rows are plain text only.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

const cap = (v, n) => (v === null || v === undefined) ? null : String(v).slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured' });

  const b = req.body || {};
  if (!b.message) return res.status(400).json({ error: 'message required' });

  const row = {
    kind:       ['onerror', 'unhandledrejection'].includes(b.kind) ? b.kind : 'onerror',
    page:       cap(b.page, 200),
    message:    cap(b.message, 500),
    stack:      cap(b.stack, 1500),
    source_url: cap(b.source_url, 300),
    line_no:    Number.isFinite(b.line_no) ? b.line_no : null,
    col_no:     Number.isFinite(b.col_no) ? b.col_no : null,
    user_agent: cap(req.headers['user-agent'], 300),
    token_hint: cap(b.token_hint, 8),
  };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SECRET,
        Authorization: `Bearer ${SUPABASE_SECRET}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
