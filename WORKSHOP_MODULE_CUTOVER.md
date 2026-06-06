# Workshop Module — Cutover & Test Runbook

Branch: `workshop-module` (off `main`). Migration **v35 already applied to production Supabase** (additive, verified). No new environment variables required.

## What was built
- **Schema (v35, live):** `workshops`, `workshop_participants`, `workshop_questions`, `workshop_responses`; created `testimonials`/`referrals` (v22 was never applied to prod); added `clients.is_workshop_participant`. RLS deny-all on all. 21 standard template questions seeded.
- **Endpoints:** `api/workshop-data.js` (coach: roster upload, AI questions, aggregate, exports, GHL, invites, recap, reminder cron), `api/workshop-survey.js` (participant pre/post + sponsor feedback/NPS branch/testimonial/referral), `api/workshop-sponsor.js` (read-only sponsor dashboard). `api/coach-data.js` allowlist extended.
- **Pages:** `coach.html` Workshops tab (setup, roster, questions, data, recap); `workshop-survey.html` (mobile survey + sponsor feedback mode); `workshop-room.html` (sponsor dashboard).
- **Config:** `vercel.json` rewrites `/workshop-room`, `/workshop-survey`; daily reminder cron `0 13 * * *`.

## Step 1 — Push the branch (you, on your Mac)
Add only the workshop files (avoid sweeping stray docs):

```
git checkout workshop-module
git add api/workshop-data.js api/workshop-survey.js api/workshop-sponsor.js api/coach-data.js coach.html workshop-room.html workshop-survey.html vercel.json supabase-migration-v35-workshop-module.sql cleanup-workshop-test-data.sql
git commit -m "Workshop Module v35: setup, surveys, indices/exports, feedback flywheel"
git push origin workshop-module
```
Vercel builds a **preview**. Use the newest deployment for the branch; confirm status **Ready**.

## Step 2 — Test on the PREVIEW (not production)
A `TEST Workshop — Acme Exec Team` is already seeded (4 participants, pre+post data: Trust 3.0→4.0, Proactivity 2.5→4.0, Productivity 2.5→3.5, NPS 50).

- **Coach:** `<preview>/coach` → log in → **Workshops** tab → open the TEST workshop. Check each sub-tab: Overview (Generate exec summary, Generate recommendation), Roster (paste a small CSV → Upload; Send pre/post — sends real email, use your own address), Questions (AI suggest → approve; add custom), Data (Compute indices → should match the numbers above; Export participant/sponsor/GHL CSVs), Recap (Send recap).
- **Sponsor dashboard:** `<preview>/workshop-room?token=78440d63-49bb-41e7-9be9-82bba96eb5dd` — exec summary, timeline, recommendation.
- **Participant survey:** `<preview>/workshop-survey?token=d1664944-7a2c-461e-a135-5d52dd6cf12c&phase=post` — progress, save & resume, submit.
- **Sponsor feedback / flywheel:** `<preview>/workshop-survey?token=78440d63-49bb-41e7-9be9-82bba96eb5dd&mode=feedback` — try NPS 10 (promoter → bonus + referral), 8 (satisfied → soft referral), 6 (service recovery → flags needs_review), 3 (red flag).
- **Regression:** coach login, a client portal check-in, Ask Alex, a Decision Room sponsor link, a diagnostic survey — all still work.

## Step 3 — Merge to production
```
git checkout main
git merge workshop-module
git push origin main
```
Smoke-test the live domain: `/coach` → Workshops tab loads; `/workshop-room?token=...` renders; `/workshop-survey?token=...` loads.

## Step 4 — Clean up test data
Run `cleanup-workshop-test-data.sql` in the Supabase SQL editor (removes only `TEST %` rows).

## Rollback (if needed)
`git revert -m 1 HEAD && git push origin main`. The additive v35 migration can stay (old code never reads the new tables). Full rollback SQL is in the bottom of `supabase-migration-v35-workshop-module.sql`.

## Notes / decisions
- One profile per person: participants & sponsor are `clients` rows; participants flagged `is_workshop_participant=true` to stay out of the coaching list.
- Sponsor dashboard is **aggregate-only** (never per-individual), so individuals are protected.
- AI question suggestions land as `draft` and require coach approval before participants see them.
- v22 was never applied to prod — v35 self-healed `testimonials`/`referrals`. The existing coach testimonial/referral UI (if any) will now have its backing tables for the first time.
