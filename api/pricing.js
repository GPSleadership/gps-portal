// GPS Leadership — Pricing & Credit API (P0-5: config-driven pricing, never hardcoded)
//
// Single source of truth for what a client sees about money:
//   • GET  /api/pricing?token=<client token OR diagnostic leader token>
//       Token-scoped, READ-ONLY. Returns THIS client's diagnostic credit (via the
//       diagnostic_credit() SQL function), the credit window, and the offer URLs
//       from renewal_config. The browser never computes a credit and never reads
//       pricing tables directly.
//   • POST /api/pricing  { action, session, ... }   — owner-gated writes:
//       config-get        read pricing_config (any valid coach session)
//       config-save       edit pricing_config (owner only, audited)
//       snapshot-client   freeze a client's quoted terms + amount_paid (owner only, audited)
//       credit-override   set/clear a per-client credit override (owner only, audited)
//
// Guardrails (build spec):
//   • Only the standard diagnostic price is creditable. credit =
//     min(coalesce(credit_override, amount_paid), standard_diagnostic_price) —
//     computed in SQL (diagnostic_credit), never in the browser.
//   • pricing_config.confirmed is set by Alex when the real numbers are confirmed;
//     this endpoint never flips it on its own.
//   • pricing_config / client_pricing_snapshot / pricing_audit are RLS deny-all and
//     served only here with the service key. Never add them to the generic proxy.
//
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Coach session verification — same HMAC scheme as api/coach-data.js.
function verifyCoachSession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch { return null; }
  if (!payload || payload.role !== 'coach' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

async function firstRow(path) {
  try {
    const r = await sb(path);
    if (!r.ok) return null;
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0]) || null;
  } catch (_) { return null; }
}

// Server-side credit via the SECURITY DEFINER SQL function. Null on any failure —
// callers treat null as "don't show a number", never as "show a default number".
async function diagnosticCredit(clientId) {
  if (!clientId) return null;
  try {
    const r = await sb('/rest/v1/rpc/diagnostic_credit', 'POST', { p_client_id: String(clientId) });
    if (!r.ok) return null;
    const v = await r.json();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

async function auditLog({ actor, action, clientId, before, after, reason }) {
  try {
    await sb('/rest/v1/pricing_audit', 'POST', {
      actor: actor || 'unknown', action, client_id: clientId || null,
      before: before || null, after: after || null, reason: reason || null,
    }, { Prefer: 'return=minimal' });
  } catch (_) { /* audit is best-effort; the write itself already succeeded */ }
}

const CONFIG_FIELDS = ['standard_diagnostic_price', 'pro_diagnostic_price', 'coaching_monthly', 'sprint_months', 'credit_window_days', 'confirmed'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Warm-cron ping: return before auth/DB so the container stays hot for real loads.
  if (req.method === 'GET' && req.query && req.query.ping === '1') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, ping: true });
  }
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  // ── GET: token-scoped, read-only client view ───────────────────────────────
  if (req.method === 'GET') {
    const token = String((req.query && req.query.token) || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    // Resolve the token to a client id: clients.token first, then a diagnostic
    // leader token (diagnostic-leader.html passes its own token).
    let clientId = null;
    const cl = await firstRow(`/rest/v1/clients?token=eq.${enc(token)}&select=id&limit=1`);
    if (cl) clientId = cl.id;
    if (!clientId) {
      const dg = await firstRow(`/rest/v1/diagnostics?leader_token=eq.${enc(token)}&select=client_id&limit=1`);
      if (dg && dg.client_id) clientId = dg.client_id;
    }
    if (!clientId) return res.status(401).json({ error: 'Invalid or expired link' });

    const cfg  = await firstRow('/rest/v1/pricing_config?id=eq.1&select=standard_diagnostic_price,credit_window_days,confirmed&limit=1');
    const snap = await firstRow(`/rest/v1/client_pricing_snapshot?client_id=eq.${enc(String(clientId))}&select=standard_diagnostic_price,credit_window_days&limit=1`);
    const rc   = await firstRow('/rest/v1/renewal_config?id=eq.1&select=first_sprint_credit_url,first_sprint_standard_url,continuation_flex_url,continuation_titan_url,booking_url&limit=1');
    const credit = await diagnosticCredit(clientId);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      credit,                                                        // number | null (null = show nothing)
      standard_diagnostic_price: (snap && snap.standard_diagnostic_price) ?? (cfg && cfg.standard_diagnostic_price) ?? null,
      credit_window_days:        (snap && snap.credit_window_days)        ?? (cfg && cfg.credit_window_days)        ?? null,
      confirmed:                 !!(cfg && cfg.confirmed),
      urls: {
        first_sprint_credit:   (rc && rc.first_sprint_credit_url)   || null,
        first_sprint_standard: (rc && rc.first_sprint_standard_url) || null,
        continuation_flex:     (rc && rc.continuation_flex_url)     || null,
        continuation_titan:    (rc && rc.continuation_titan_url)    || null,
        booking:               (rc && rc.booking_url)               || null,
      },
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── POST: coach-gated management actions ───────────────────────────────────
  const body    = req.body || {};
  const session = verifyCoachSession(body.session);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  const isOwner     = (session.lvl || 'owner') === 'owner';
  const ownerOnly   = () => res.status(403).json({ error: 'Owner-only action. Ask Alex to make this change.' });
  const senderEmail = session.em || 'alex@gpsleadership.org';

  try {
    switch (body.action) {

      case 'config-get': {
        const cfg = await firstRow('/rest/v1/pricing_config?id=eq.1&select=*&limit=1');
        return res.status(200).json({ ok: true, config: cfg });
      }

      // Recent audit trail (owner only — it contains amounts and reasons).
      case 'audit-list': {
        if (!isOwner) return ownerOnly();
        try {
          const r = await sb('/rest/v1/pricing_audit?select=actor,action,client_id,reason,created_at&order=created_at.desc&limit=20');
          const rows = r.ok ? await r.json() : [];
          return res.status(200).json({ ok: true, audit: Array.isArray(rows) ? rows : [] });
        } catch (_) { return res.status(200).json({ ok: true, audit: [] }); }
      }

      // Read one client's frozen terms + computed credit (any valid coach session —
      // read-only; the writes below stay owner-only).
      case 'client-pricing-get': {
        const clientId = String(body.client_id || '').trim();
        if (!clientId) return res.status(400).json({ error: 'client_id required' });
        const snap = await firstRow(`/rest/v1/client_pricing_snapshot?client_id=eq.${enc(clientId)}&select=*&limit=1`);
        const credit = await diagnosticCredit(clientId);
        return res.status(200).json({ ok: true, snapshot: snap, credit });
      }

      case 'config-save': {
        if (!isOwner) return ownerOnly();
        const before = await firstRow('/rest/v1/pricing_config?id=eq.1&select=*&limit=1');
        const upd = { updated_at: new Date().toISOString() };
        for (const f of CONFIG_FIELDS) {
          if (body[f] === undefined) continue;
          if (f === 'confirmed') { upd.confirmed = body.confirmed === true; continue; }
          const n = Number(body[f]);
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `Invalid value for ${f}` });
          upd[f] = n;
        }
        const r = await sb('/rest/v1/pricing_config?id=eq.1', 'PATCH', upd, { Prefer: 'return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not save pricing config', detail: d }); }
        const after = (await r.json())[0] || null;
        await auditLog({ actor: senderEmail, action: 'config-save', before, after, reason: body.reason });
        return res.status(200).json({ ok: true, config: after });
      }

      case 'snapshot-client': {
        if (!isOwner) return ownerOnly();
        const clientId = String(body.client_id || '').trim();
        if (!clientId) return res.status(400).json({ error: 'client_id required' });
        const cfg = await firstRow('/rest/v1/pricing_config?id=eq.1&select=*&limit=1');
        if (!cfg) return res.status(500).json({ error: 'pricing_config missing — seed it first' });
        const before = await firstRow(`/rest/v1/client_pricing_snapshot?client_id=eq.${enc(clientId)}&select=*&limit=1`);
        const amountPaid = (body.amount_paid === undefined || body.amount_paid === null || body.amount_paid === '')
          ? (before ? before.amount_paid : null)
          : Number(body.amount_paid);
        if (amountPaid !== null && (!Number.isFinite(amountPaid) || amountPaid < 0)) {
          return res.status(400).json({ error: 'Invalid amount_paid' });
        }
        const row = {
          client_id: clientId,
          standard_diagnostic_price: cfg.standard_diagnostic_price,
          pro_diagnostic_price:      cfg.pro_diagnostic_price,
          coaching_monthly:          cfg.coaching_monthly,
          sprint_months:             cfg.sprint_months,
          credit_window_days:        cfg.credit_window_days,
          amount_paid:               amountPaid,
          updated_at:                new Date().toISOString(),
        };
        const r = await sb('/rest/v1/client_pricing_snapshot?on_conflict=client_id', 'POST', row,
          { Prefer: 'resolution=merge-duplicates,return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not snapshot client pricing', detail: d }); }
        const after = (await r.json())[0] || row;
        await auditLog({ actor: senderEmail, action: 'snapshot-client', clientId, before, after, reason: body.reason });
        const credit = await diagnosticCredit(clientId);
        return res.status(200).json({ ok: true, snapshot: after, credit });
      }

      case 'credit-override': {
        if (!isOwner) return ownerOnly();
        const clientId = String(body.client_id || '').trim();
        if (!clientId) return res.status(400).json({ error: 'client_id required' });
        const reason = String(body.reason || '').trim();
        const clearing = body.credit_override === null || body.credit_override === '';
        if (!clearing && !reason) return res.status(400).json({ error: 'A reason is required for a credit override' });
        let override = null;
        if (!clearing) {
          override = Number(body.credit_override);
          if (!Number.isFinite(override) || override < 0) return res.status(400).json({ error: 'Invalid credit_override' });
        }
        let before = await firstRow(`/rest/v1/client_pricing_snapshot?client_id=eq.${enc(clientId)}&select=*&limit=1`);
        if (!before) {
          // Overriding a client with no snapshot: freeze current config first so the
          // override is anchored to known terms.
          const cfg = await firstRow('/rest/v1/pricing_config?id=eq.1&select=*&limit=1');
          if (!cfg) return res.status(500).json({ error: 'pricing_config missing — seed it first' });
          await sb('/rest/v1/client_pricing_snapshot?on_conflict=client_id', 'POST', {
            client_id: clientId,
            standard_diagnostic_price: cfg.standard_diagnostic_price,
            pro_diagnostic_price:      cfg.pro_diagnostic_price,
            coaching_monthly:          cfg.coaching_monthly,
            sprint_months:             cfg.sprint_months,
            credit_window_days:        cfg.credit_window_days,
          }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }
        const r = await sb(`/rest/v1/client_pricing_snapshot?client_id=eq.${enc(clientId)}`, 'PATCH', {
          credit_override: override,
          override_reason: clearing ? null : reason,
          override_by:     clearing ? null : senderEmail,
          updated_at:      new Date().toISOString(),
        }, { Prefer: 'return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not set credit override', detail: d }); }
        const after = (await r.json())[0] || null;
        await auditLog({ actor: senderEmail, action: 'credit-override', clientId, before, after, reason });
        const credit = await diagnosticCredit(clientId);
        return res.status(200).json({ ok: true, snapshot: after, credit });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
