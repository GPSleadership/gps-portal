# GPS Portal (Tool Creation) — working rules for Claude
Read this before doing any work in this folder.

## ⭐ SINGLE SOURCE OF TRUTH for build/fix work — non-negotiable
Whenever **any** session discovers something to build, fix, or come back to later — a bug, a
gap, a "we should add X," a deferred idea — append it to:

### `GPS_PORTAL_MASTER_BUILD_LIST.md` (in this folder)

Put it under the right priority section (**P0** live exposure/revenue · **P1** this week ·
**P2** schedule it · **P3** later). This is the ONE backlog.

**Never track portal build/fix items anywhere else** — not in a session task list you'll lose,
not in a new stray file, not scattered in Supabase. If you catch yourself about to "note it for
later" somewhere else, stop and put it in the Master Build List instead.

- `GPS_PORTAL_BACKLOG.md` is **retired** — it now just points here.
- `cio_findings` (Supabase) is an **evidence/audit ledger only**; the prioritized *action* list
  lives in the Master Build List. Findings from the CIO / system-health loops get reconciled
  into it, not left in the ledger.
- At the **end** of any session that worked on portal items, update their status in the Master
  Build List (mark ✅ Done with the date).

## Time-based reminders are a different list
Dated reminders (invoices, renewals, a follow-up on a date) go in **`REMINDERS.md`**, not the
build list. Build/fix = Master Build List; "remind me on <date>" = REMINDERS.md.

## Portal changes follow the safe-build workflow
Any change to the portal (coach.html, client.html, decision-room.html, sponsor.html, the
survey/diagnostic pages, `api/*.js`, `vercel.json`, migrations) goes through the
**`gps-portal-safe-build`** workflow: branch → Vercel preview → test → additive migration →
merge to `main`. Never edit `main` directly. Run the JS syntax sweep before staging any HTML.

## Client-facing resilience is required
Any page a prospect, sponsor, client, or rater loads must retry transient failures on its
critical load, isolate secondary widgets so one failure can't blank the page, and never
auto-retry a submit. (Full standard is in the `gps-portal-safe-build` skill.)

## Colors: use brand tokens, never hardcode hex
Every color must be a CSS variable from **`BRAND_TOKENS.md`** (the single source of truth). Never
write a raw hex like `#004369` in markup, styles, or JS-built style strings — use `var(--navy)`,
`var(--text-muted)`, etc. If a genuinely new color is unavoidable: add it to `:root`, name it
semantically, document it in `BRAND_TOKENS.md`, then use the var. Before staging any HTML, run
`python3 scripts/color-guard.py <file>.html` — it flags any new raw hex you introduced (the ratchet
that keeps us from drifting back to 245 near-identical colors). This is why the token work exists;
don't undo it one hardcoded color at a time.
