// api/testimonial.js — GPS Leadership Portal
// Testimonial & Referral Flywheel
// All actions routed via ?action= query param

import crypto from 'node:crypto';

const SB_URL    = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';

const ALLOWED_SOURCES   = ['diagnostic_debrief', 'coaching_midpoint', 'engagement_end'];
const ALLOWED_ENG_TYPES = ['diagnostic_only', 'diagnostic_plus_coaching'];
const ALLOWED_CFG_KEYS  = ['referral_bonus_label', 'referral_bonus_value_display',
                            'referral_bonus_conditions_text', 'coaching_access_description'];

async function sb(path, method = 'GET', body = null, extra = {}) {
  const r = await fetch(`${SB_URL}${path}`, {
    method,
    headers: {
      apikey: SB_SECRET,
      Authorization: `Bearer ${SB_SECRET}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function authClient(token) {
  if (!token) return null;
  const r = await sb(
    `/rest/v1/clients?token=eq.${encodeURIComponent(token)}&select=id,name,email,title,organization,engagement_type,first_big_win_flag,industry,sector_type,in_coaching_program,is_active_coaching,coaching_sessions_enabled&limit=1`
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

// Coach auth now uses the same signed session as the rest of the portal — no plaintext
// password, no GPS2026 fallback, and no dependency on the anon-writable gps_settings table.
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

async function extractBenefitSentence(testimonialResponses) {
  const combined = Object.values(testimonialResponses).filter(Boolean).join(' | ');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: 'You extract a single plain-English benefit sentence from leadership coaching testimonial responses. Output ONLY one sentence, max 20 words, no quotes. Use first person ("get clearer on...", "have better conversations...", etc). No financials, no internal names, no politics. Focus on clarity, leadership impact, or organizational execution.',
        messages: [{ role: 'user', content: `Responses: ${combined}` }],
      }),
    });
    if (!r.ok) throw new Error('Claude error');
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || 'get much clearer on where my leadership was the bottleneck and what to do about it';
  } catch {
    return 'get much clearer on where my leadership was the bottleneck and what to do about it';
  }
}

function buildReferralEmail(client, ref, benefitSentence, engType) {
  const isGov = ['government', 'gov'].some(k =>
    (client.industry || '').toLowerCase().includes(k) ||
    (client.sector_type || '').toLowerCase().includes(k)
  );
  const refFirst    = (ref.referral_name || '').split(' ')[0] || ref.referral_name;
  const clientFirst = (client.name || '').split(' ')[0] || client.name;
  const andCoaching = engType === 'diagnostic_plus_coaching' ? ' and coaching' : '';
  const drivingLine = ref.referral_org
    ? `Given ${isGov ? "the mission you're responsible for at" : "what you're driving at"} ${ref.referral_org}, I thought you might value a short conversation with him.`
    : "I thought you might value a short conversation with him.";
  const challengeLine = isGov ? 'mission, people, and execution' : 'similar growth and leadership challenges';
  const contextLine = ref.referral_org
    ? `${refFirst} leads ${ref.referral_org} and is navigating ${challengeLine}.`
    : `${refFirst} is navigating ${challengeLine}.`;

  const subject = isGov
    ? `Quick introduction: ${clientFirst} & GPS Leadership Solutions (leadership support)`
    : `Quick introduction: ${clientFirst} & GPS Leadership Solutions`;

  const body = `Hi ${refFirst},

I wanted to introduce you to Alex Tremble, Founder & CEO of GPS Leadership Solutions. I've been working with him through a 14-Day Executive Leadership Diagnostic${andCoaching}, and it's helped me ${benefitSentence}.

${drivingLine}

Alex — ${contextLine} I'll let you two take it from here.

${client.name || ''}
${client.title || ''}
${client.organization || ''}`;

  return { subject, body };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  try {
    switch (action) {
      case 'get-referral-config':       return handleGetConfig(req, res);
      case 'public-quotes':             return handlePublicQuotes(req, res);
      case 'get-pending-prompt':        return handleGetPendingPrompt(req, res);
      case 'save-testimonial':          return handleSaveTestimonial(req, res);
      case 'get-testimonials':          return handleGetTestimonials(req, res);
      case 'save-referrals':            return handleSaveReferrals(req, res);
      case 'mark-referral-sent':        return handleMarkReferralSent(req, res);
      case 'client-flag-win':           return handleClientFlagWin(req, res);
      case 'coach-get-testimonials':    return handleCoachGetTestimonials(req, res);
      case 'coach-get-referrals':       return handleCoachGetReferrals(req, res);
      case 'coach-list-pending':        return handleCoachListPending(req, res);
      case 'coach-toggle-permission':   return handleTogglePermission(req, res);
      case 'coach-set-win-flag':        return handleSetWinFlag(req, res);
      case 'coach-set-engagement-type': return handleSetEngagementType(req, res);
      case 'coach-update-config':       return handleUpdateConfig(req, res);
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[testimonial]', action, err);
    return res.status(500).json({ error: err.message });
  }
}

// Public, no-auth: approved + client-consented testimonials for display at decision
// points in the portal. Returns only a short quote + name/title — exactly what the
// coach approved and the client agreed to share. Capped and read-only.
async function handlePublicQuotes(req, res) {
  const tr = await sb(`/rest/v1/testimonials?permission_public_use=eq.true&review_status=eq.approved&select=client_id,responses,created_at&order=created_at.desc&limit=12`);
  if (!tr.ok) return res.status(200).json({ quotes: [] });
  const rows = (await tr.json()).filter(t => t && t.responses && t.responses._consent === true);
  if (!rows.length) return res.status(200).json({ quotes: [] });
  const ids = Array.from(new Set(rows.map(r => r.client_id).filter(Boolean)));
  let names = {};
  if (ids.length) {
    const cr = await sb(`/rest/v1/clients?id=in.(${ids.join(',')})&select=id,name,title,organization`);
    if (cr.ok) (await cr.json()).forEach(c => { names[c.id] = c; });
  }
  const quotes = rows.map(r => {
    const resp = r.responses || {};
    const quote = (resp.q3 || resp.q1 || resp.q2 || '').trim();
    if (!quote) return null;
    const c = names[r.client_id] || {};
    const attribution = [c.name, c.title || c.organization].filter(Boolean).join(' · ');
    return { quote: quote.slice(0, 280), attribution };
  }).filter(Boolean);
  return res.status(200).json({ quotes });
}

async function handleGetConfig(req, res) {
  const r = await sb(`/rest/v1/gps_settings?key=in.(${ALLOWED_CFG_KEYS.map(k => `"${k}"`).join(',')})&select=key,value`);
  if (!r.ok) return res.status(500).json({ error: 'Config fetch failed' });
  const rows = await r.json();
  return res.status(200).json(Object.fromEntries(rows.map(row => [row.key, row.value])));
}

async function handleGetPendingPrompt(req, res) {
  const body = req.method === 'POST' ? (req.body || {}) : req.query;
  const { client_token, diagnostic_id, force_end_prompt } = body;

  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });

  const tR = await sb(`/rest/v1/testimonials?client_id=eq.${client.id}&select=source`);
  const existing = tR.ok ? (await tR.json()).map(t => t.source) : [];

  // 1. Debrief trigger
  if (!existing.includes('diagnostic_debrief') && diagnostic_id) {
    const dR = await sb(`/rest/v1/diagnostics?id=eq.${diagnostic_id}&select=debrief_completed_at&limit=1`);
    if (dR.ok) {
      const diags = await dR.json();
      if (diags[0]?.debrief_completed_at) {
        return res.status(200).json({ pending_source: 'diagnostic_debrief' });
      }
    }
  }

  // 2. Big-win trigger (any coaching client whose coach flagged a milestone)
  const isCoaching = client.engagement_type === 'diagnostic_plus_coaching' ||
    client.in_coaching_program || client.is_active_coaching || client.coaching_sessions_enabled;
  if (!existing.includes('coaching_midpoint') && isCoaching && client.first_big_win_flag) {
    return res.status(200).json({ pending_source: 'coaching_midpoint' });
  }

  // 3. End-of-engagement (force only for now)
  if (!existing.includes('engagement_end') && force_end_prompt === 'true') {
    return res.status(200).json({ pending_source: 'engagement_end' });
  }

  return res.status(200).json({ pending_source: null });
}

async function handleSaveTestimonial(req, res) {
  const { client_token, source, responses, rating_nps } = req.body || {};
  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });
  if (!ALLOWED_SOURCES.includes(source)) return res.status(400).json({ error: 'Invalid source' });
  if (rating_nps != null) {
    const n = Number(rating_nps);
    if (isNaN(n) || n < 0 || n > 10) return res.status(400).json({ error: 'NPS must be 0–10' });
  }

  const r = await sb('/rest/v1/testimonials', 'POST', {
    client_id: client.id,
    engagement_type: client.engagement_type || 'diagnostic_only',
    source,
    responses: responses || {},
    rating_nps: rating_nps != null ? Number(rating_nps) : null,
  }, { Prefer: 'return=representation' });
  if (!r.ok) { const e = await r.text(); return res.status(500).json({ error: e.slice(0, 200) }); }
  const saved = await r.json();
  const t = Array.isArray(saved) ? saved[0] : saved;
  return res.status(200).json({ id: t.id, rating_nps: t.rating_nps, eligible_for_referral: t.rating_nps != null && t.rating_nps >= 9 });
}

async function handleGetTestimonials(req, res) {
  const { client_token } = req.body || req.query;
  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });
  const r = await sb(`/rest/v1/testimonials?client_id=eq.${client.id}&select=id,source,rating_nps,created_at&order=created_at.desc`);
  if (!r.ok) return res.status(500).json({ error: 'Fetch failed' });
  return res.status(200).json({ testimonials: await r.json() });
}

async function handleSaveReferrals(req, res) {
  const { client_token, referrals, testimonial_id } = req.body || {};
  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });
  if (!Array.isArray(referrals) || referrals.length === 0) return res.status(400).json({ error: 'referrals array required' });
  if (referrals.length > 3) return res.status(400).json({ error: 'Max 3 referrals' });

  let benefitSentence = 'get much clearer on where my leadership was the bottleneck and what to do about it';
  if (testimonial_id) {
    const tR = await sb(`/rest/v1/testimonials?id=eq.${testimonial_id}&client_id=eq.${client.id}&select=responses&limit=1`);
    if (tR.ok) {
      const rows = await tR.json();
      if (rows[0]?.responses) benefitSentence = await extractBenefitSentence(rows[0].responses);
    }
  }

  const results = [];
  for (const ref of referrals) {
    if (!ref.name?.trim() || !ref.email?.trim()) continue;
    const refObj = { referral_name: ref.name.trim(), referral_org: ref.org?.trim() || null };
    const { subject, body } = buildReferralEmail(client, refObj, benefitSentence, client.engagement_type || 'diagnostic_only');
    const rR = await sb('/rest/v1/referrals', 'POST', {
      referrer_client_id: client.id,
      referral_name: ref.name.trim(),
      referral_email: ref.email.trim(),
      referral_org: ref.org?.trim() || null,
      engagement_type_suggested: client.engagement_type || 'diagnostic_only',
      email_subject: subject,
      email_body: body,
      status: 'draft_email_created',
    }, { Prefer: 'return=representation' });
    if (rR.ok) {
      const s = await rR.json();
      const row = Array.isArray(s) ? s[0] : s;
      results.push({ id: row.id, referral_name: row.referral_name, referral_email: row.referral_email, email_subject: row.email_subject, email_body: row.email_body });
    }
  }
  return res.status(200).json({ referrals: results });
}

async function handleMarkReferralSent(req, res) {
  const { client_token, referral_id } = req.body || {};
  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });
  const check = await sb(`/rest/v1/referrals?id=eq.${referral_id}&referrer_client_id=eq.${client.id}&select=id&limit=1`);
  if (!check.ok || !(await check.json()).length) return res.status(404).json({ error: 'Referral not found' });
  const r = await sb(`/rest/v1/referrals?id=eq.${referral_id}`, 'PATCH', { status: 'sent', sent_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}

async function handleCoachGetTestimonials(req, res) {
  const { coach_password, client_id } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const r = await sb(`/rest/v1/testimonials?client_id=eq.${client_id}&order=created_at.desc`);
  if (!r.ok) return res.status(500).json({ error: 'Fetch failed' });
  return res.status(200).json({ testimonials: await r.json() });
}

async function handleCoachGetReferrals(req, res) {
  const { coach_password, client_id } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const r = await sb(`/rest/v1/referrals?referrer_client_id=eq.${client_id}&order=created_at.desc`);
  if (!r.ok) return res.status(500).json({ error: 'Fetch failed' });
  return res.status(200).json({ referrals: await r.json() });
}

// Pending approval queue for the Today view: testimonials the client submitted with
// consent that the coach hasn't acted on yet. Joins the client name/title/org for display.
async function handleCoachListPending(req, res) {
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  const r = await sb(`/rest/v1/testimonials?review_status=eq.pending&select=id,client_id,source,rating_nps,responses,created_at&order=created_at.desc`);
  if (!r.ok) return res.status(500).json({ error: 'Fetch failed' });
  const rows = await r.json();
  // Only surface ones where the client consented to public use (responses._consent).
  const pending = (Array.isArray(rows) ? rows : []).filter(t => t && t.responses && t.responses._consent === true);
  return res.status(200).json({ pending });
}

async function handleTogglePermission(req, res) {
  const { coach_password, testimonial_id, permission_public_use } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!testimonial_id) return res.status(400).json({ error: 'testimonial_id required' });
  const approve = !!permission_public_use;
  const r = await sb(`/rest/v1/testimonials?id=eq.${testimonial_id}`, 'PATCH', {
    permission_public_use: approve,
    review_status: approve ? 'approved' : 'declined',
    reviewed_at: new Date().toISOString(),
  }, { Prefer: 'return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}

async function handleSetWinFlag(req, res) {
  const { coach_password, client_id, first_big_win_flag } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const r = await sb(`/rest/v1/clients?id=eq.${client_id}`, 'PATCH', { first_big_win_flag: !!first_big_win_flag, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}

// Client self-service: a coaching client flags their own big win during a check-in.
// Token-auth (no coach session), coaching clients only. Sets the same flag the coach
// would set, so it surfaces in the coach's Today approval queue.
async function handleClientFlagWin(req, res) {
  const { client_token } = req.body || {};
  const client = await authClient(client_token);
  if (!client) return res.status(401).json({ error: 'Invalid client token' });
  const isCoaching = !!(client.in_coaching_program || client.is_active_coaching || client.coaching_sessions_enabled);
  if (!isCoaching) return res.status(403).json({ error: 'Not a coaching client' });
  const r = await sb(`/rest/v1/clients?id=eq.${client.id}`, 'PATCH', { first_big_win_flag: true, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}

async function handleSetEngagementType(req, res) {
  const { coach_password, client_id, engagement_type } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  if (!ALLOWED_ENG_TYPES.includes(engagement_type)) return res.status(400).json({ error: 'Invalid engagement_type' });
  const r = await sb(`/rest/v1/clients?id=eq.${client_id}`, 'PATCH', { engagement_type, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}

async function handleUpdateConfig(req, res) {
  const { coach_password, key, value } = req.body || {};
  if (!verifyCoachSession((req.body || {}).session)) return res.status(403).json({ error: 'Unauthorized' });
  if (!ALLOWED_CFG_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid config key' });
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
  const r = await sb('/rest/v1/gps_settings', 'POST', { key, value, updated_at: new Date().toISOString() }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  if (!r.ok) return res.status(500).json({ error: 'Update failed' });
  return res.status(200).json({ ok: true });
}
