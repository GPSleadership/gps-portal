# GPS Portal — Security Action List (for Alex)

These are the items that need **you** — a login, a decision, or a sign-off. I can't do them for you. Ordered by urgency. Full context is in `GPS_Portal_Premortem_2026-06-03.md`.

## Do today (2 minutes)

- [ ] **Set an Anthropic monthly spend cap.** console.anthropic.com → Settings → Limits → set a monthly spend limit (even $50–100 is a generous ceiling) + an email alert at ~50%. This caps the damage from the open `/api/ask` proxy until the real fix lands.

## Resolved

- [x] **Vercel plan.** Now on Vercel Pro (purchased June 2026). This removes the 12-function cap (premortem #9) and the 60s timeout ceiling (#10) — the 300s `diagnostic.js` report timeout is now properly supported. Both findings closed.

## Decide this week

- [ ] **Pick a new coach dashboard password.** After the hashed-login fix is deployed, the old plaintext one gets replaced. Choose a strong one (not `GPS2026`). You'll set it once at cutover.

## After the Phase 1 fix is built (your sign-off)

- [ ] **Review the `security-hardening-phase1` branch** before it deploys. I'll build it; you approve it on a Vercel preview URL before it touches production.
- [ ] **Approve the cutover window.** The RLS lockdown + app changes go live together. Pick a low-traffic time (not during a live coaching session or an open diagnostic).
- [ ] **Rotate the coach password** at cutover (set the new hashed one).

## Lower priority (when convenient)

- [ ] Set up an uptime monitor (UptimeRobot/BetterStack) on `/coach`, `/client`, `/api/health`.
- [ ] Create a free Sentry project; I'll wire the snippet into both HTML pages.
- [ ] Do one test restore of a backup into a scratch Supabase project to prove recovery works.

---
*Created June 3, 2026. Items I complete on your behalf get checked off here as they land.*
