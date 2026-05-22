# GPS Leadership Portal — Product Roadmap

---

## ✅ Phase 1 — Complete (April 2026)

**Goal:** A working, branded client portal for the 90-Day Leadership Engagement.

- Client portal (`client.html`) — token-based access, no login required
- 90-Day Plan form (Form B) — TP3 pillar, goal, metric, rewards
- Weekly check-in form (Form A) — weeks 1–12, metric tracking, reflection
- Coach dashboard (`coach.html`) — password-protected, Supabase-backed
- Add/archive/delete clients
- Per-client diagnostic report link
- Executive Leadership Toolkit (resource links)
- Email notifications via Resend (plan submitted, check-in submitted)
- Week 9 automated client email
- GHL CSV export
- Full JSON data backup / export
- Custom domain: `portal.gpsleadership.org`
- Secure password change with email verification code
- Persistent coach session (24-hour localStorage, no re-login on every visit)
- Plan edit unlock/lock toggle — coach unlocks Form B for a client to re-edit, auto-locks on resubmit
- Client timezone self-selection on first Form B submission
- Automated weekly Monday reminder emails (`api/send-reminders.js`) — sends only to clients who haven't checked in yet that week
- Reminder emails include Google Calendar and Apple/Outlook (ICS) recurring event links
- "Send Test Reminders Now" in coach dashboard — previews the reminder email to alex@gpsleadership.org
- Vercel cron job: every Monday 9am ET

---

## 🔜 Phase 2 — Planned (Priority Order)

### 1. PWA (Progressive Web App)
Convert the existing portal into an installable mobile app experience.
- Clients can tap "Add to Home Screen" on iPhone or Android
- Opens full-screen with GPS icon — looks and feels like a native app
- No App Store required, no rebuilding — same Supabase backend, same token-based access
- Estimated effort: ~half day of configuration

### 2. Client Questions & Notes Capture
Give clients a space to flag what's on their mind before each coaching call.
- Optional free-text field on Form A: "Anything you want to cover on your next call?"
- Surfaces in coach dashboard on the check-in detail view
- Helps Alex walk into calls already knowing what's coming

### 3. Missed Check-In Flagging
- Flag clients in the coach dashboard who have no submission in 10+ days
- Visual indicator (red dot or badge) on the client row
- Removes the need to manually scan for gaps

### 4. Metric Trend Chart
- Visual chart on the client detail panel: baseline → week-by-week → target
- Makes progress (or lack of it) immediately visible without reading through individual check-ins

### 5. Timezone-Precise Reminders
- Currently all reminders fire at 9am ET for everyone
- Update `send-reminders.js` to fire at 9am in each client's local timezone
- Requires timezone-aware scheduling logic (staggered sends based on stored timezone)
- PT clients currently receive reminders at 6am — low priority fix, but worth cleaning up

### 6. SMS Reminders (Twilio)
- Same-day nudge if a client hasn't submitted by Monday afternoon
- Higher open rate than a second email
- Requires: Twilio account, phone number (~$1/month), A2P 10DLC carrier registration
- Not free, but low cost at this volume (~$0.01/text)
- Lower priority than items above — email + calendar reminders are sufficient for now

### Coach Dashboard Improvements (candidates)
- Filter clients by TP3 pillar
- Bulk archive actions
- Notes field per client (coach-only, not visible to client)
- Progress bar on client row showing week X of 12

### GoHighLevel Integration
- Auto-sync new client records into GHL on plan submission
- Requires GHL API key + custom field IDs from GHL Settings

---

## 💭 Phase 3 — Under Consideration

- True native mobile app (React Native or Flutter) — revisit if offline capability, push notifications, or App Store presence becomes a real need
- Multi-coach support (separate logins per coach)
- Automated renewal outreach sequence after week 12
- Client self-service onboarding (client sets up own plan without coach input)
- Milestone celebrations at weeks 4, 8, and completion
- Client-facing 90-day journey summary at week 12

---

*Last updated: May 2026*
