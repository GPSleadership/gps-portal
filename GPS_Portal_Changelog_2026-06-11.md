# GPS Leadership Portal — Session Changelog
**Date:** 2026-06-11
**Scope:** All edits, fixes, migrations, and data changes made in this working session.
**Files touched:** `coach.html`, `api/workshop-data.js`, `api/import-clients.js`, `api/diagnostic.js`, `gps-executive-console-deploy.html`, plus new migration/record files.

---

## Database migrations (applied to prod — additive)
| ID | Change | Why |
|----|--------|-----|
| v48 | `workshop_participants.last_reminder_at` | get-roster SELECTed a missing column → empty rosters. |
| v49 | `clients.website` | Optional company website; light context for diagnostic reports. |
| v50 | `organizations.website` | Standalone org records carry a website. |
| v51 | `teams.poc_name`, `poc_email`, `poc_phone` | Decision Room team point-of-contact (logistics only). |

SQL files: `supabase-migration-v48..v51-*.sql`, `supabase_schema_snapshot_2026-06-11.sql`.

## Data corrections (applied to prod)
- Backfilled `organization = "Jackson Municipal Airport Authority (JMAA)"` on the 23 JMAA assessment participants (only filled blanks). File: `data-change-2026-06-10-jmaa-org-backfill.sql`.
- Set the **JMAA Exec Team** `client_org_name` to the canonical JMAA string (was blank from the old team-create flow) so the member filter works.
- Enabled `interviews_enabled` on the existing **Rosa Beckett** Pro diagnostic.

---

## Code changes

### Clients & import
- **Bulk import fixed:** `api/import-clients.js` was `.vercelignore`d (404). Un-ignored + registered in `vercel.json`. Added phone capture, dedup-by-email, and friendly "already exist" messaging instead of a red error.
- **Add-client form:** removed the obsolete "Diagnostic Report Link" field; added optional **Company Website**. Website also added to the edit form and passed into the diagnostic report generator as light background context.

### Diagnostics
- **Create flow:** closes the client-profile overlay on create so you land on the new diagnostic (was rendering behind the overlay → "nothing happened").
- **Pro tier auto-enables interviews** so the scheduling-link field appears up front.
- **All Diagnostics list:** per-row **Archive / Unarchive / Delete** (delete cascades cleanly).
- **TIER_PRICES crash fixed:** a top-level `const` was referenced before initialization during load → blank dashboard. Moved inside `applyTierPriceLabels()`. (Tier price labels still editable in one place.)

### Organizations
- New **Add/Edit Organization** modal from the home **+ Add** menu: name, website, **industry autocomplete**, **revenue-band dropdown**, **logo file upload** (`org-logo-upload` action → Supabase Storage `org-assets`), notes.
- New standalone **Organizations** top-level tab (list + add + edit). Removed the Organizations button from Workshops & Assessments.
- `org-create` / `org-update` extended for `website`.

### Workshops / Assessments
- Roster upload now **auto-inherits the engagement's organization** onto participants with no org (row org still wins). Per-person **Tie / Untie** control on the roster (`set-participant-org`).

### Decision Room (Teams)
- **Team create** is now a modal with **org autocomplete**; organization is **required**; cancel no longer creates a team.
- **Archive / Delete** on every team (delete cascades).
- **Member picker filtered to the team's organization** with a "Show everyone" toggle.
- **Sponsor add no longer auto-emails** — use the per-sponsor **Email link** button when ready.
- **Edit sponsor:** change who they supervise + confidentiality (`drEditSponsor`).
- **Point of contact** card on the team (logistics only, no access/email) + **pick an existing person** to auto-fill name/email/phone.

### Executive console (separate, not yet deployed)
- `gps-executive-console-deploy.html` mobile-hardened: overflow-x guard, single-column grids on phones, long-string wrapping. Packaged as `ops-console-deploy/index.html` for Bluehost upload. Confirmed only the Supabase **anon** key is embedded (safe).

---

## Infrastructure notes
- **portal.gpsleadership.org** is already live on Vercel (custom domain done). No action needed.
- **Executive console → Bluehost**: file ready (`ops-console-deploy/index.html`); Alex to create `ops.alextremble.com` subdomain, upload, and add Directory Privacy. Mobile to be verified live after deploy.

## Outstanding / queued (recommended order)
1. Sponsor view: show **Name — Title** (not title-only). *(task 28)*
2. Sponsor view: clean up empty **Recommendations** block → "Nothing in motion yet." *(29)*
3. Add-client form: **auto-fill website/industry/revenue** from chosen org. *(30)*
4. **Org logo** on diagnostic + team-scorecard pages. *(24)*
5. **POC progress view** (gated, no reports/data). *(27)*
6. Executive console **Bluehost deploy + mobile verify**. *(19)*
7. **Coaching stats** dashboard. *(23)*
8. **F2** private report bucket. *(16)*
