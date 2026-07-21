// api/legal-text.js
// Public, read-only serve of the ACTIVE legal text for a given key.
// Single source of truth = public.legal_texts. Every render surface (survey consent
// gate, invite email, checkout notice, report/PDF footer, privacy page, Ask Alex
// label) pulls from here so the wording can never drift or be forgotten.
//
// This endpoint only ever returns the ACTIVE version of a key, and only the fields
// meant to be shown (id, key, version, body). Editing/publishing is owner-gated and
// lives in api/coach-data.js (actions: legal-text-list, legal-text-publish).

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

// Keys the browser is allowed to request. A typo or a probe for some other key
// returns "not found" rather than leaking anything unexpected.
const PUBLIC_KEYS = new Set([
  'survey_consent',
  'system_entry_ack',
  'ai_output_label',
  'invite_line',
  'checkout_notice',
  'report_footer',
  'privacy_section',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const key = String((req.query && req.query.key) || (req.body && req.body.key) || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing key' });
  if (!PUBLIC_KEYS.has(key)) return res.status(404).json({ ok: true, active: false });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/legal_texts?key=eq.${encodeURIComponent(key)}&is_active=eq.true&select=id,key,version,body,effective_from&limit=1`,
      { headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` } }
    );
    if (!r.ok) return res.status(502).json({ error: 'Upstream error' });
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    // No active version = surface must fail safe (gate blocks, guardrail blocks sends).
    if (!row) return res.status(200).json({ ok: true, active: false, key });
    // Never leak an internal editorial marker to a client-facing surface. The admin
    // editor (owner path) still shows the full text incl. any "[DRAFT …]" note so Alex
    // knows it isn't finalized; this public serve strips it so a client never sees it.
    if (row.body) {
      row.body = String(row.body)
        .replace(/\[\s*draft\b[^\]]*\]/gi, '')   // remove any [DRAFT …] marker anywhere
        .replace(/[ \t]+\n/g, '\n')              // tidy trailing spaces left behind
        .replace(/\n{3,}/g, '\n\n')              // collapse blank runs
        .trim();
    }
    // Brief cache so render surfaces aren't hammered; short enough that a publish
    // shows up for new visitors within a minute.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ ok: true, active: true, id: row.id, key: row.key, version: row.version, body: row.body });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load legal text' });
  }
}
