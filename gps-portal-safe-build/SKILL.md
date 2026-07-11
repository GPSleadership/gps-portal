---
name: gps-portal-safe-build
description: >
  Use whenever making ANY change to the GPS Leadership portal (the gps-portal repo:
  coach.html, client.html, decision-room.html, feedback.html, survey/diagnostic pages,
  api/*.js serverless functions, vercel.json, or Supabase migrations) — or to a similar
  single-repo web app deployed on Vercel with a Supabase backend. Enforces a
  branch → preview → seed/test → checks → migrate → merge workflow so production is
  never edited directly and the live portal is never broken. This includes client-facing
  RESILIENCE: any page a prospect, sponsor, client, or rater can load must retry transient
  failures and never show a raw break. Trigger on: "change the portal", "add a feature to
  coach/client", "edit the Decision Room", "new portal endpoint", "fix the portal",
  "build X into the portal", or any edit to the portal files under the working folder.
---

# GPS Portal — Safe Build Workflow

**Golden rule: never edit `main` directly, and never push untested code to production.**
Every change goes onto a branch, gets a Vercel preview, is tested with seed data, passes
the checks, and only then merges to `main` (which auto-deploys to `portal.gpsleadership.org`).

The user runs all `git` commands on their Mac. Provide exact, single-line commands
(no backslash line-continuations; assume they are already in the repo directory).

## 1. Start on a branch — never on main
```
git checkout main && git pull origin main && git checkout -b <short-feature-name>
```
If the user is mid-feature, confirm which branch they're on (`git branch --show-current`)
before editing.

## 2. Build in small, verifiable increments
After each file edit, validate syntax before moving on:
- `api/*.js`: `node --check api/<file>.js`
- HTML pages: run the JS syntax sweep (Step 7) before committing — mandatory.
- Scan `coach.html` and `client.html` for escaped backticks (`\``) — baseline must be **0**.

## 3. Respect the security model (CRITICAL — post-v26 lockdown)
- The browser NEVER queries Supabase with the anon key. The anon key is dead for data.
- All reads/writes go through token/session-validated serverless endpoints using `SUPABASE_SECRET_KEY`:
  - Client data → `api/portal-data.js` (token-scoped)
  - Coach data → `api/coach-data.js` (HMAC verifyCoachSession)
  - Sponsor data → `api/sponsor-data.js` (security boundary)
  - Diagnostic / email → `api/diagnostic.js`
- A new read/write = **add an endpoint action**, never a browser-side anon call.
- Confidentiality = omit server-side. Never hide in UI only; never rely on RLS as the gate.
- Never expose `SUPABASE_SECRET_KEY` to the browser. Never add an anon RLS policy to unblock a read.

## 3b. Client-facing resilience (REQUIRED) — a user never sees a raw break
A prospect, sponsor, client, or rater must never see a blank page, a dead spinner, or an
error card caused by a transient failure. A serverless cold start, a dropped connection, or
a one-off 5xx is EXPECTED — the front end absorbs it. Any change that adds or touches a
client-facing page load must satisfy all of the following before it merges:

1. **Retry the critical load.** The fetch that gates the whole page (render vs. error)
   retries transient failures with exponential backoff — do not dead-end on the first hiccup.
   - 3 attempts, backoff ~500ms · 1s (+ jitter), with an `AbortController` timeout (~12s) per attempt.
   - Retry ONLY: network errors (`TypeError`), timeouts (`AbortError`), and HTTP `5xx`.
   - Never retry `4xx` (invalid token, unauthorized) — surface those immediately; they are definitive.
2. **Never retry a write.** Submits and any state-changing POST (survey submit, save,
   purchase, activation) run **exactly once**. On a shared gateway used for reads AND writes,
   make retry OPT-IN (a flag) and enable it only on the load. Auto-retrying a submit can
   double-record data.
3. **Isolate every secondary widget.** Each non-critical section is wrapped so its failure
   renders a small local fallback — never blanks the page. Reserve the full-page error for a
   genuinely unusable state (critical load failed after all retries). Fail *open* on soft
   gates (an access check that errors must not lock a paying client out).
4. **Show a loading state immediately.** A skeleton + a plain reassuring caption
   ("Pulling your data… just a moment.") so a slow load reads as intentional, not broken.
   Clear it the instant real content renders.
5. **Keep hot endpoints warm.** Client-facing serverless functions are pinged by the warming
   cron (`/api/warm`). Add any new client-facing endpoint to that list, and give it a fast
   `?ping=1` short-circuit that returns before auth/DB.

Reference implementations already in the repo: `client.html` (`fetchResilient`),
`decision-room.html` (`api()`), `sponsor.html` (`resilientSponsorPost`),
`survey.html` (`resilientFetch`), `diagnostic-survey.html` (`diagPortal(..., {retry:true})`
— opt-in, load only).

## 4. Migrations are additive and applied BEFORE the merge
- Write `supabase-migration-vNN-*.sql`, additive only, with a `-- ROLLBACK` block.
- New tables: `ENABLE ROW LEVEL SECURITY` + no anon policies (deny-all; service-role only).
- Apply to production Supabase and verify, then proceed. Old code ignores new columns.

## 5. Push the branch → test on the PREVIEW (not production)
```
git add <files> && git commit -m "<message>" && git push origin <branch>
```
Vercel builds a **preview** deployment. Test on it, not the live domain:
- The bare preview root 404s. Append the page path: `https://gps-portal-<hash>.vercel.app/coach.html`
- Always use the **newest** deployment (Vercel → Deployments → top entry).
- Confirm status is **Ready**, not **Error**. If Error, read the build log before continuing.

## 6. Test with clearly-labeled seed data
- Seed test rows prefixed `TEST ` (trivially deletable). Cover strong / mid / weak leaders;
  standard + private sponsors; one-person and multi-person teams.
- Provide a one-line cleanup: `DELETE ... WHERE name LIKE 'TEST %'` in FK-safe order.
- Exercise the new flow AND a regression pass (login, check-in, Ask Alex, sponsor link).
- **Resilience check (any new/changed client-facing load):** in the browser, override
  `fetch` to fail the load twice then succeed → confirm the page recovers (no error card);
  confirm a real 4xx (bad token) still shows the correct message immediately; confirm any
  submit fires exactly once on failure (no double-submit).
- **Equivalence check (any refactor of a data path):** compare the new payload against the
  old / production output byte-for-byte with keys normalized, across every mode (e.g. standard
  / private / progress) and a real record — merge only when identical.

## 7. JS syntax sweep — MANDATORY before `git add` on any HTML file

**Why this exists:** decision-room.html crashed in production twice from the same bug — a
straight apostrophe inside a single-quoted JS string that silently terminated it early.
The result: every user sees a blank spinner. The sweep catches this in seconds.

**Run from the repo root (sandbox runs this; user runs git):**

```bash
# Check only the files you're about to stage:
python3 scripts/js-syntax-sweep.py $(git diff --name-only | grep '\.html$')

# Or check a specific file:
python3 scripts/js-syntax-sweep.py decision-room.html
```

The script (in `scripts/js-syntax-sweep.py`) does two things:
1. **Pattern scan** — greps inside every `<script>` block for the three known-dangerous patterns.
2. **Node check** — extracts each `<script>` block and runs `node --check` on it.

**Exit 0 = safe to commit. Exit 1 = fix and re-run. Do not skip.**

### The apostrophe trap — memorize this

Every time a JS string contains a person's name followed by a possessive or a word with a
contraction, there is a risk. The three forms:

| Bug | What it looks like | Fix |
|---|---|---|
| Empty-string possessive | `+esc(first)+''s role` | `+esc(first)+"'s role"` |
| Possessive after concat | `' with you, '+esc(first)+''s supervisor:'` | `+"'s supervisor:"` |
| Contraction in string | `'We'll show you'` | `"We'll show you"` |

**Rule of thumb:** any time you write `esc(firstName)` or `esc(name)` followed by a string
that starts with an apostrophe, switch that segment to double quotes.

## 8. Merge to production only when green
```
git checkout main && git merge <branch> && git push origin main
```
Smoke-test the real domain within one minute: `/coach` loads, a client portal loads and
a check-in submits, a sponsor link renders. Then delete the test rows.

## Rollback (if the smoke test fails)
```
git revert -m 1 HEAD && git push origin main
```
Production returns to the pre-change code immediately. Additive migrations stay — old code
never reads the new columns. Fix forward on a branch.

## Never do
- Edit `main` directly or push untested code to production.
- Use the anon key for data, or add an anon RLS policy to unblock a read.
- Expose the service key to the browser.
- Skip the JS syntax sweep on a modified HTML file.
- Ship a client-facing page whose critical load has no retry, or that can blank / dead-spinner
  on a cold start, or that auto-retries a submit.
- Ship a client-facing deliverable from un-reviewed AI output — drafts are coach-approved first.
