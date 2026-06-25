// api/health.js — lightweight health check for uptime monitoring (UptimeRobot/BetterStack).
// Returns 200 when the DB is reachable and required env keys are present; 503 otherwise.
// Point an external monitor at https://portal.gpsleadership.org/api/health and alert on non-200.

const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const out = { ok: true, ts: new Date().toISOString(), checks: {} };

  // Cheap DB ping — single-row read on a tiny table.
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/coach_settings?select=key&limit=1`, {
      headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}` },
    });
    out.checks.db = r.ok ? 'ok' : `error_${r.status}`;
    if (!r.ok) out.ok = false;
  } catch (e) {
    out.checks.db = 'unreachable';
    out.ok = false;
  }

  // Config presence (does not expose values).
  out.checks.supabase_key  = SUPABASE_SECRET ? 'present' : 'missing';
  out.checks.anthropic_key = process.env.ANTHROPIC_API_KEY ? 'present' : 'missing';
  if (!SUPABASE_SECRET) out.ok = false;

  // Email config — today's outage was a sender-domain problem that health didn't see.
  out.checks.resend_key = process.env.RESEND_API_KEY ? 'present' : 'missing';
  if (!process.env.RESEND_API_KEY) out.ok = false;
  // The verified Resend domain is the portal.gpsleadership.org subdomain; sending from the
  // apex gpsleadership.org 403s. Flag (warn, don't fail) if the from-address isn't the subdomain.
  const fromEmail = process.env.RESEND_FROM_EMAIL || '';
  out.checks.resend_from = !fromEmail
    ? 'default (noreply@portal.gpsleadership.org)'
    : (/@portal\.gpsleadership\.org$/i.test(fromEmail) ? 'ok' : `warn_unverified_domain:${fromEmail.replace(/^[^@]+/, '***')}`);

  return res.status(out.ok ? 200 : 503).json(out);
}
