# GPS Portal (Tool Creation) — working rules for Claude
Read this before doing any work in this folder.

## 🚨 Repo & environment integrity — non-negotiable
These exist because two iCloud-synced clones of this repo silently diverged and corrupted each
other. The clean, single copy is `~/dev/gps-portal`. The old folders (`Tool Creation`, `gps-live`)
are retired — do not use or edit them.

1. **`~/dev/gps-portal` is the ONLY repo.** Never create another clone, never work from
   `~/Documents` or anywhere inside iCloud. If another `gps-portal` folder turns up anywhere, don't
   touch it — flag it to Alex.
2. **Verify before building.** At the start of any coding session: confirm the connected folder is
   `~/dev/gps-portal`, `git fetch` succeeds, you're on `main`, and you're in sync with origin
   (behind 0 / ahead 0). If any of that isn't true, stop and reconcile with Alex before editing
   anything.
3. **Commit and push early and often.** Never leave finished edits uncommitted across sessions.
4. **One thread edits the repo at a time.** If Alex is running parallel Claude threads, only one
   may edit code — the others are read/plan only. If it's unclear which thread that is, ask.
5. **Migrations: check before numbering.** Before creating a new migration, list the existing
   `supabase-migration-v*.sql` files and use the NEXT number, to avoid filename collisions across
   threads.

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

## Build cadence — scope any day, BUILD only in the Friday window
Alex's default working rhythm: **scope throughout the week, build in one batch at the weekend.**

- **Scoping is welcome any time.** When Alex raises an idea, bug, or "we should add X," capture it
  in the Master Build List (per the rule above) — do NOT start building it. Confirm it's logged and
  move on.
- **Do NOT build mid-week by default.** When Alex asks to *build / add / change* something during the
  week, push back first: ask whether it needs to ship today or can wait for the Friday build window.
  Default to deferring. One question, respectfully, then honor his answer.
- **Build mid-week ONLY when** it's a live P0/P1 fix (something broken or exposed in production), or
  Alex explicitly says he needs it today. A fix that makes an already-shipped feature usable counts;
  a net-new feature almost never does.
- **The window:** a recurring reminder fires Friday ~6pm ET and preps the week's queue from this
  tracker. Alex runs one Fable build thread over the weekend and clears the batch. When a build
  session runs, work the queue top-down through the safe-build workflow.

If in doubt, the answer is "log it for the Friday window," not "let's build it now."

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
