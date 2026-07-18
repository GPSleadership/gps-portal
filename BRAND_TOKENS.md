# GPS Executive Impact System — Brand Tokens (single source of truth)

**Rule of the road:** never hardcode a color. Use a token from the list below. If a genuinely new
color is needed, add it here first (with a reason), define it once in the page's `:root`, then use
the `var(--token)` everywhere. This is what keeps us from drifting back to 245 near-identical hex codes.

This applies to every page in the system: `coach.html`, `client.html`, `decision-room.html`,
`sponsor.html`, `survey.html`, `diagnostic-*.html`. Each page defines these in its own `:root` block
today (a future "Branding panel" will centralize them — see the Master Build List).

## Core palette

| Token | Value | Use it for |
|---|---|---|
| `--navy` | #004369 | Primary brand. Headers, primary buttons, key headings. |
| `--navy-dark` | #002D47 | Darker navy for gradients / hovers. |
| `--teal` | #01949A | Accent / call-to-action. The "go" color. |
| `--red` | #DB1F48 | Brand red. Badges, alerts that are still on-brand, accents. |
| `--sand` | #E5DDC8 | Warm neutral accent. |

## Neutrals (text, borders, surfaces)

| Token | Value | Use it for |
|---|---|---|
| `--text` | #1a1a1a | Primary body text. |
| `--text-muted` | #5a6b76 | Secondary text, labels, metadata. **The default for greyed text.** |
| `--text-faint` | #9aa7ad | Tertiary / placeholder text. |
| `--slate` | #94a3b8 | Muted slate accents (bluer). |
| `--slate-2` | #8a99a0 | Muted grey-slate (greyer). |
| `--border` | #dbe3e6 | Default hairline border. |
| `--line` | #cbd5e1 | Lighter divider. |
| `--surface-2` | #eef1f2 | Soft panel background. |
| `--light-teal` | #E8F7F7 | Teal-tinted background (info panels). |
| `--light-sand` | #F7F4EE | Sand-tinted background (table headers). |
| `--gray-100` | #f5f5f5 | App background. |
| `--gray-200` | #e8e8e8 | Light borders / dividers. |
| `--gray-300` | #d0d0d0 | Input borders. |
| `--gray-600` | #666666 | Muted text (legacy; prefer `--text-muted`). |
| `--white` | #ffffff | Cards, surfaces. |

## Status colors

| Token | Value | Use it for |
|---|---|---|
| `--ok` | #2e7d32 | Success / complete (green). |
| `--warn` | #e65100 | Warning / pending (orange). |
| `--err` | #dc2626 | Error / destructive (red, distinct from brand `--red`). |

## Decision Room theme (decision-room.html)

`--d-blue #1A3D6E`, `--d-gold #C09A2A`, `--d-dark #1C1C1C`, `--d-mid #555`, `--d-light #F4F6F9`,
`--d-border #DDE2EA`, `--d-green #1A7A3A`, `--d-amber #BF6A00`, `--d-red2 #CC2200`,
`--d-blue-light #EAF0FA`, `--d-gold-light #FDF8EE`. Scoped to the Decision Room's premium look.

## When you think you need a new color

1. Check this list first — 90% of the time an existing token fits.
2. Status tints (a faint bg behind a status badge) are the usual exception. Reuse an existing tint
   if one is close. Only add a new one if a status genuinely has no home.
3. If you add one: put it in `:root`, name it semantically (what it MEANS, not what it looks like —
   `--warn`, not `--orange`), document it here, and note why.
4. Run `python3 scripts/color-guard.py <file>.html` before committing — it flags any raw hex you
   introduced that isn't a token, so sprawl can't creep back in silently.

_Last updated 2026-07-18. Coach console migrated: ~741 hardcoded colors now flow through these tokens._
