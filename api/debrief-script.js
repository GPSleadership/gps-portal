// GPS Leadership — AI Debrief Script generator (coach-only)
//
// Generates a read-aloud debrief SCRIPT in Alex's voice/flow, filled with THIS
// leader's real data, at the moment the coach opens it (always in sync with the
// current report + 90-day draft — nothing is cached). Mirrors Alex's real 6-part
// choreography learned from his actual debriefs, with three 1-10 touchpoints and
// a money treatment that auto-flexes on funding type.
//
// POST /api/debrief-script  { action, session, diagnostic_id, ... }
//   generate       -> the structured script (steps/blocks) + any existing capture
//   save-capture   -> upsert the coach's 3 scores + outcome + funding override
//
// GUARDRAILS (executive-council, non-negotiable):
//   * EXTRACTIVE ONLY. Every quote/number/name is copied from a source field.
//     Nothing is model-generated. This file contains ZERO LLM calls by design —
//     it cannot fabricate a quote or invent a score.
//   * MIN-GROUP-3 de-anonymization filter, fail-closed. A rater group with n<3 is
//     never quoted to the leader. The single-rater supervisor read is surfaced
//     ONLY in a coach-only "sponsor signal" cue, never as a spoken quote.
//   * Pricing pulled live from config (never hardcoded). Money spoken only when
//     funding_type = 'self'.
//   * Coach-only. Labeled AI-generated/unverified. Served only through this
//     coach-gated endpoint; debrief_captures is RLS deny-all.
//
// ENV: SUPABASE_URL, SUPABASE_SECRET_KEY, COACH_SESSION_SECRET

import crypto from 'node:crypto';

const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET      = process.env.SUPABASE_SECRET_KEY;
const COACH_SESSION_SECRET = process.env.COACH_SESSION_SECRET || '';
const MIN_GROUP_N = 3;

const enc = encodeURIComponent;

function sb(path, method = 'GET', body = null, extra = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function firstRow(path) {
  try { const r = await sb(path); if (!r.ok) return null; const rows = await r.json(); return (Array.isArray(rows) && rows[0]) || null; }
  catch (_) { return null; }
}
function verifyCoachSession(token) {
  if (!token || !COACH_SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', COACH_SESSION_SECRET).update(parts[0]).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
  if (!p || p.role !== 'coach' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

const money = (v) => (v == null || v === '') ? null : '$' + Number(v).toLocaleString('en-US');
const first = (name) => String(name || 'this leader').trim().split(/\s+/)[0] || 'this leader';

// Detect whether the leader is boss-sponsored (someone else funds it) or self-funded.
// Best-effort: team membership under a sponsor engagement => sponsor-funded.
async function detectFunding(clientId) {
  if (!clientId) return { funding_type: null, sponsor_name: null };
  try {
    const tm = await sb(`/rest/v1/team_members?client_id=eq.${enc(clientId)}&select=team_id&limit=20`);
    const teams = tm.ok ? await tm.json() : [];
    const teamIds = (Array.isArray(teams) ? teams : []).map(t => t.team_id).filter(Boolean);
    if (!teamIds.length) return { funding_type: 'self', sponsor_name: null };
    const st = await sb(`/rest/v1/sponsor_teams?team_id=in.(${teamIds.map(enc).join(',')})&select=sponsor_id&limit=5`);
    const links = st.ok ? await st.json() : [];
    if (!Array.isArray(links) || !links.length) return { funding_type: 'self', sponsor_name: null };
    const sponsor = await firstRow(`/rest/v1/sponsors?id=eq.${enc(links[0].sponsor_id)}&select=name&limit=1`);
    return { funding_type: 'sponsor', sponsor_name: (sponsor && sponsor.name) || null };
  } catch (_) { return { funding_type: null, sponsor_name: null }; }
}

// ── The deterministic assembler ──────────────────────────────────────────────
// Alex's fixed voice/flow is the template; only real data is slotted in.
function buildScript({ diag, scores, narrative, pricing, credit, funding, sponsorName }) {
  const S = scores || {};
  const N = narrative || {};
  const grp = S.by_group || {};
  const name = diag.client_name || 'this leader';
  const fn = first(name);
  const org = diag.client_org || 'your organization';

  const impact = S.impact != null ? Number(S.impact) : null;
  const selfTp3 = grp.self && grp.self.tp3 != null ? Number(grp.self.tp3) : null;
  const trust = S.trust, pro = S.proactivity, prod = S.productivity;

  // Self-vs-others read (extractive comparison, not a judgment call).
  let selfRead = '';
  if (selfTp3 != null && impact != null) {
    const d = impact - selfTp3;
    if (d >= 0.2) selfRead = `And one more thing worth naming: you rated yourself a ${selfTp3.toFixed(1)}, below how everyone else sees you at ${impact.toFixed(2)}. So if anything, you are being harder on yourself than the people around you are.`;
    else if (d <= -0.2) selfRead = `One thing to sit with: you rated yourself a ${selfTp3.toFixed(1)}, above how others experience you at ${impact.toFixed(2)}. That gap is worth a curious, non-defensive look today.`;
    else selfRead = `And your self-rating of ${selfTp3.toFixed(1)} lines up closely with how others see you at ${impact.toFixed(2)} — you have a clear, accurate read on yourself.`;
  }

  // Min-group-3 filter: which groups may be quoted, and the coach-only supervisor signal.
  const quotableGroups = Object.entries(grp)
    .filter(([g, v]) => g !== 'self' && v && Number(v.n) >= MIN_GROUP_N)
    .map(([g, v]) => ({ group: g, n: Number(v.n) }));
  const supRow = grp.supervisor;
  const supBelowN = supRow && Number(supRow.n) > 0 && Number(supRow.n) < MIN_GROUP_N;

  // Safe strength quote: team_quote is team-aggregated (a group of 3+), so quotable.
  const strengthQuote = N.team_quote || null;
  // Gap theme: prefer a "start" SSC item (team-level, safe) that names the gap.
  const gapTheme = (S.ssc && Array.isArray(S.ssc.start) && S.ssc.start[0]) || null;
  const secondTheme = (S.ssc && Array.isArray(S.ssc.start) && S.ssc.start[1]) || (S.ssc && Array.isArray(S.ssc.stop) && S.ssc.stop[0]) || null;

  const focus1 = N.focus1 || 'the one behavior the data points to (edit live into their words)';
  const focus2 = N.focus2 || null;

  // Money numbers (live from config).
  const stdPrice   = pricing && pricing.standard_diagnostic_price;
  const window     = (pricing && pricing.credit_window_days) != null ? pricing.credit_window_days : 7;
  const priceCredit = (pricing && pricing.price_first_credit)   != null ? pricing.price_first_credit   : 10000;
  const priceStd    = (pricing && pricing.price_first_standard) != null ? pricing.price_first_standard : 15000;
  const creditAmt   = (credit != null && credit > 0) ? credit : stdPrice;

  const steps = [];

  // 0 — Open & frame
  steps.push({ title: '0 · Open & frame', time: '~5 min', blocks: [
    { kind: 'cue', label: 'Rapport first', text: `60 seconds, genuine. Something specific about ${fn} / ${org} before you shift in.` },
    { kind: 'say', text: `So let's jump into it. First off, I want to thank you for doing this. The reality is most leaders never invite this level of feedback, especially running things at your level. Just going through this process puts you in the small minority.` },
    { kind: 'say', text: `Quick frame for today. One, how to read the diagnostic, what it is and what it isn't. Two, the big picture, how others experience your leadership. Three, your key strengths and priority opportunities. And four, the most important piece, your one 90-day focus and a simple plan in your portal, because nothing changes until we do something differently.` },
    { kind: 'say', text: `This is meant to be light on your time but heavy on impact. One behavior, about 10 minutes a week to track. Not a second full-time job. Does that sound like the right use of our time?` },
    { kind: 'ask', label: 'Personal-goal anchor — ask & wait', text: `Before we get into the data, remind me: when you think three to five years out, what are you ultimately trying to build for yourself and for ${org}?` },
    { kind: 'cue', label: 'Listen for & reuse', text: `Their real 3-5 year goal. Probe past the polished answer. You will tie the 90-day plan and the offer back to this at the end.` },
  ] });

  // Money frame — early, ONLY for self-funded (one honest sentence).
  if (funding === 'self') {
    steps[0].blocks.push({ kind: 'say', text: `One thing so nothing sneaks up on you later. The diagnostic is step one of a paid 90-day system. If what we find today points to going deeper, there is an investment on the other side, and I will lay out the exact number at the end. Nothing we talk about today is contingent on it.` });
  }

  // 1 — Reality vs truth + temperature check
  steps.push({ title: '1 · Reality vs truth', time: '~2 min', blocks: [
    { kind: 'say', text: `One frame before the numbers. This report doesn't tell us the truth about you as a person. It tells us how the people around you are experiencing you right now. And that's their truth, and their truth is the truth, because perception is reality. Our job today is to decide whose perceptions matter most, what you keep reinforcing, and what you change over the next 90 days so ${org} relies less on you personally and more on your leaders. And this is for your development, not a performance rating.` },
    { kind: 'ask', label: 'Temperature check — hand him the mic first', text: `Before I say anything, I want to hear from you. What stood out when you looked at the report? Anything surprising, positive or negative, anything you strongly disagreed with or felt was unfair?` },
    { kind: 'cue', label: 'Listen for', text: `Hot buttons, what they already see, their internal narrative. Reflect back 1-2 points before you move on.` },
  ] });

  // 2 — Big picture
  const dataTiles = [];
  if (impact != null) dataTiles.push({ n: Number(impact).toFixed(2), l: 'Impact (others)' });
  if (trust != null)  dataTiles.push({ n: Number(trust).toFixed(2), l: 'Trust' });
  if (pro != null)    dataTiles.push({ n: Number(pro).toFixed(2), l: 'Proactivity' });
  if (prod != null)   dataTiles.push({ n: Number(prod).toFixed(2), l: 'Productivity' });

  const bigBlocks = [
    { kind: 'cue', label: 'Scale explainer first', text: `"A five walks on water. Four is great. Three is average, and our cutoff is four, because the companies we work with aren't interested in average leaders."` },
  ];
  if (dataTiles.length) bigBlocks.push({ kind: 'data', tiles: dataTiles });
  bigBlocks.push({ kind: 'say', text: `Here's the headline. ${N.sowhat || N.headline || 'You are rated at a strong standard across the board, with one focused opportunity we will build the plan around.'}` });
  if (selfRead) bigBlocks.push({ kind: 'say', text: selfRead });
  bigBlocks.push({ kind: 'cue', label: 'Strengths first (cushion) · quote only groups of 3+', text: quotableGroups.length ? `Quotable groups: ${quotableGroups.map(g => g.group.replace('_', ' ') + ' (' + g.n + ')').join(', ')}.` : `No group has 3+ responses — speak strengths in general terms, do not quote.` });
  if (strengthQuote) bigBlocks.push({ kind: 'say', text: `Let's start with what's clearly working. Your team describes you, and I'm quoting, as someone who: "${strengthQuote}" What do you do that you think creates that experience for people?` });
  bigBlocks.push({ kind: 'ask', text: `Which of these strengths do you absolutely want to protect and double down on over the next year?` });
  bigBlocks.push({ kind: 'cue', label: 'Now the one gap that matters', text: `Name it plainly, give the data, ask for their view. Lead: "${N.honest_read || 'this is the one pattern worth getting ahead of.'}"` });
  if (gapTheme) bigBlocks.push({ kind: 'say', text: `Here's the one pattern worth getting ahead of. It shows up repeatedly. One person put it this way: "${gapTheme}"` });
  bigBlocks.push({ kind: 'ask', text: `How much does that resonate with what you see? Where do you agree, and where do you feel the numbers don't tell the whole story?` });
  if (secondTheme) bigBlocks.push({ kind: 'cue', label: 'Second signal (optional)', text: `"${secondTheme}"` });
  if (supBelowN && N.supervisor_quote) {
    bigBlocks.push({ kind: 'cue', label: 'Sponsor signal — COACH ONLY, do NOT quote aloud (single rater)', text: `The person they report to named it in their own words: "${N.supervisor_quote}" That means the focus isn't your opinion — it's already on their radar. Hold this for the close.` });
  }
  bigBlocks.push({ kind: 'say', text: `I'm not saying every comment is precise. I'm saying if enough people experience you a certain way, it will eventually affect your ability to step back without performance dropping. So it's worth paying attention to. If we fixed just one thing over the next 90 days, my vote would be this one. How does that land for you?` });
  // Value touchpoint 1 — BEFORE the portal tour.
  bigBlocks.push({ kind: 'ask', label: 'Value touchpoint 1 — ask & wait (before the portal tour)', text: `Before I walk you through the system, real quick and easy: one to ten, how valuable has the report and our time together been so far?` });
  bigBlocks.push({ kind: 'capture', field: 'value_pre', label: 'Log the "value so far" score', text: `The priming yes. Hope for 8-10. Keep it a genuine calibration, not a gate — the portal tour happens either way.` });
  steps.push({ title: '2 · The big picture', time: '~20 min', blocks: bigBlocks });

  // 3 — Lock the 90-day focus
  const focusBlocks = [
    { kind: 'cue', label: 'Pull the portal pre-draft. Ground-truth it live, edit into their words.' },
    { kind: 'say', text: `I've already pulled a first draft of your 90-day focus from the data. Let's look at it together and tweak the words so it sounds like you. Here's what I'd propose as your single focus: "${focus1}" If we only changed one behavior for the next 90 days, is this the right one?` },
    { kind: 'cue', label: 'Edit live', text: `Build the metric with them. Ask real numbers, set a baseline, pick lead vs lag. "You don't shift perception in the silence. You do it with a bright light on you."` },
    { kind: 'ask', label: 'Commitment', text: `On a scale of 1 to 10, how important is it to you to actually change this in the next 90 days?` },
  ];
  if (focus2) focusBlocks.push({ kind: 'cue', label: 'Day-60 add-on', text: `Second focus once the first is moving: "${focus2}"` });
  focusBlocks.push({ kind: 'capture', field: 'commitment_note', optional: true, label: 'Lock the plan in the portal', text: `Log the behavior + metric + baseline (pre-fills the check-in).` });
  steps.push({ title: '3 · Lock the 90-day focus', time: '~12 min', blocks: focusBlocks });

  // 4 — Portal tour
  steps.push({ title: '4 · Portal tour & tools', time: '~6 min', blocks: [
    { kind: 'say', text: `Quick tour so you know where everything lives. My Plan is your 90-day focus and your weekly check-in, about 10 minutes a week, this is home base. Resources is your toolkit. Ask Alex is your on-demand thinking partner, trained on my books and your actual scores, it always gives you one thing to do in 24 hours and one in the next 7 days. And Contact Your Coach is your direct line to me.` },
    { kind: 'cue', label: 'Tie 1-2 tools to their focus, pre-favorite one', text: `Then get it on their phone: "The leaders who get the most out of this pin the portal to their home screen. Do that now, I'll wait."` },
  ] });

  // 5 — Recap, goal tie-in, the two closing questions, and the offer
  const closeBlocks = [
    { kind: 'cue', label: 'Recap the arc', text: `Strengths to protect, the one focus, the metric from baseline toward target, the first step, the 10-min weekly rhythm. Then tie it to their 3-5 year goal from the top.` },
    { kind: 'say', text: `Earlier you said your bigger goal is [their words]. This 90-day plan is basically reps for that version of you. What we just picked is exactly what lets you step back without the business wobbling, which is the whole point of where you're trying to go.` },
    { kind: 'ask', label: 'Value touchpoint 2 — ask & wait', text: `Two quick questions to wrap. First, one to ten, how valuable was our time together today?` },
    { kind: 'capture', field: 'value_end', label: 'Log the "value today" score', text: `The second yes, reconfirmed.` },
    { kind: 'ask', label: 'Appetite touchpoint 3 — the real one', text: `And second, different scale: one to ten, how helpful do you think it'd be to have me working alongside you over the next 90 days, actually implementing this?` },
    { kind: 'capture', field: 'appetite', label: 'Log the sprint-appetite score', text: `If they're ambivalent, offer the number up: "Can I take that as a 9?"` },
  ];
  if (funding === 'self') {
    closeBlocks.push({ kind: 'cue', label: 'If 8+', text: `Reframe as low risk: "Let's treat this as a 90-day experiment, a Sprint. At day 45 and day 90 we re-run the data so you can see the movement." Then the money, anchored high.` });
    // Anchor HIGH first, then the credit walks them down to the smaller number.
    closeBlocks.push({ kind: 'say', text: `Here's the number, plainly. The 90-Day Sprint is a ${money(priceStd) || '$15,000'} investment. But you've already put ${money(creditAmt) || money(stdPrice) || '$5,000'} into the diagnostic, and if you move within the next ${window} days, that credits straight in. So it's really a ${money(priceCredit) || '$10,000'} decision, not ${money(priceStd) || '$15,000'}. That's the math. Take the week. I'd rather you be sure than quick.` });
  } else {
    const sp = sponsorName ? sponsorName : 'the person who funds this';
    closeBlocks.push({ kind: 'cue', label: 'Sponsor-funded — no price to the leader', text: `Route the decision to the sponsor. "${sponsorName ? sponsorName + ' already flagged this in their own words' : 'The person you report to has already named this'}, so this Sprint is you delivering on something they've already asked for. With your permission I'll walk ${sp} through the same picture." Never name a number to the leader.` });
  }
  closeBlocks.push({ kind: 'capture', field: 'outcome', label: 'Log the outcome', text: `yes / thinking / not now. Paired with the three scores above, this is your debrief-to-sprint conversion data.` });
  steps.push({ title: '5 · Recap, goal tie-in & the offer', time: '~10 min', blocks: closeBlocks });

  // 6 — Close
  steps.push({ title: '6 · Close', time: '~3 min', blocks: [
    { kind: 'say', text: `I'll send a short follow-up recapping your focus, the metric, and linking the exact tools we talked about. Everything's already in your portal, so you've got one place for it all. Watch for the follow-up and the weekly reminders. If something big comes up, use the portal to reach me. Any questions before we wrap?` },
    { kind: 'cue', label: 'Book the next call live before you hang up. End on genuine praise in your voice.' },
  ] });

  return {
    leader: { name, title: diag.client_title || '', org, rater_count: S.rater_count || null, impact: impact != null ? Number(impact).toFixed(2) : null },
    funding_type: funding,
    sponsor_name: sponsorName || null,
    headline: N.headline || null,
    steps,
    guardrail_note: `Coach-only. AI-assisted, extractive, unverified — verify every quote and number against the report before saying it aloud. Only rater groups of ${MIN_GROUP_N}+ are quoted; single-rater reads are coach-only and never spoken to the leader.` + (funding === 'self' ? ' Money spoken (self-funded): anchor high, credit walks it down.' : ' Money routed to sponsor, no price spoken to the leader.'),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.ping === '1') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ ok: true, ping: true }); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_SECRET) return res.status(500).json({ error: 'Server misconfigured — missing secret key' });

  const body = req.body || {};
  const session = verifyCoachSession(body.session);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  const senderEmail = session.em || 'alex@gpsleadership.org';
  const diagnosticId = String(body.diagnostic_id || '').trim();
  if (!diagnosticId) return res.status(400).json({ error: 'diagnostic_id required' });

  try {
    switch (body.action) {
      case 'generate': {
        const diag = await firstRow(`/rest/v1/diagnostics?id=eq.${enc(diagnosticId)}&select=id,client_name,client_title,client_org,client_id,results_narrative,report_generated_at,report_finalized_at&limit=1`);
        if (!diag) return res.status(404).json({ error: 'Diagnostic not found' });
        if (!diag.report_generated_at) return res.status(400).json({ error: 'Generate the report first — the script builds from it.' });

        const draft = await firstRow(`/rest/v1/diagnostic_report_drafts?diagnostic_id=eq.${enc(diagnosticId)}&select=scores_json,generated_at&order=generated_at.desc&limit=1`);
        const scores = (draft && draft.scores_json) ? draft.scores_json : {};
        const narrative = diag.results_narrative || {};

        const pricing = await firstRow('/rest/v1/pricing_config?id=eq.1&select=standard_diagnostic_price,credit_window_days&limit=1') || {};
        const rc = await firstRow('/rest/v1/renewal_config?id=eq.1&select=price_first_credit,price_first_standard&limit=1') || {};
        Object.assign(pricing, rc);
        let credit = null;
        if (diag.client_id) {
          try { const cr = await sb('/rest/v1/rpc/diagnostic_credit', 'POST', { p_client_id: String(diag.client_id) }); if (cr.ok) { const v = Number(await cr.json()); if (Number.isFinite(v) && v > 0) credit = v; } } catch (_) {}
        }

        // Existing capture (holds any funding override the coach set).
        const cap = await firstRow(`/rest/v1/debrief_captures?diagnostic_id=eq.${enc(diagnosticId)}&select=*&limit=1`);
        let funding = cap && cap.funding_type;
        let sponsorName = null;
        if (!funding) { const d = await detectFunding(diag.client_id); funding = d.funding_type || 'self'; sponsorName = d.sponsor_name; }
        else if (funding === 'sponsor') { const d = await detectFunding(diag.client_id); sponsorName = d.sponsor_name; }

        const script = buildScript({ diag, scores, narrative, pricing, credit, funding, sponsorName });
        return res.status(200).json({ ok: true, script, capture: cap || null, source_report_at: draft && draft.generated_at });
      }

      case 'save-capture': {
        const clean = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null; };
        const outcome = ['yes', 'thinking', 'no'].includes(body.outcome) ? body.outcome : null;
        const funding = ['self', 'sponsor'].includes(body.funding_type) ? body.funding_type : null;
        const row = {
          diagnostic_id: diagnosticId,
          funding_type: funding,
          value_pre: clean(body.value_pre),
          value_end: clean(body.value_end),
          appetite: clean(body.appetite),
          outcome,
          notes: (typeof body.notes === 'string' ? body.notes : '').slice(0, 2000) || null,
          captured_by: senderEmail,
          updated_at: new Date().toISOString(),
        };
        const r = await sb('/rest/v1/debrief_captures?on_conflict=diagnostic_id', 'POST', row, { Prefer: 'resolution=merge-duplicates,return=representation' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(500).json({ error: 'Could not save capture', detail: d }); }
        const saved = (await r.json())[0] || row;
        return res.status(200).json({ ok: true, capture: saved });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
