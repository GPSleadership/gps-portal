# Coaching Side Review — GPS Executive Impact System (coach.html)

**Date:** 2026-07-18 · **Reviewer:** GPS Tech/Portal Agent · **Scope:** the console you run the practice from (coach.html). Client-facing (client.html) and sponsor (decision-room.html) sides are out of scope for this pass.

**One-line verdict:** The engine is strong; the dashboard in front of it is cluttered. You don't have a features problem, you have a *findability* problem. Below, scored honestly, with a fix order.

---

## Scores (four pillars, honest grades)

| Pillar | Grade | Why |
|---|---|---|
| **Admin/Coach UX** (navigation, task flow, cognitive load) | **B–** | Good bones (a real "Today" command center, global search, grouped nav) undercut by 9 top-level groups, inconsistent depth, and three items filed in the wrong place. This is where your "I get confused where to go" comes from. |
| **Visual & Positioning** | **B–** (provisional) | Layout is clean and on-brand, but styling is done with hundreds of inline hex colors and one-off spacing instead of shared tokens, so consistency drifts screen to screen. Needs a live-session look to grade to the pixel. |
| **Technical Soundness / Long-Term** | **C+** | The entire console is one ~14,000-line HTML file with inline styles and inline `onclick` handlers throughout. It works, and you ship fast on it, but every new feature widens the nav and makes the file harder to touch. This is the real 6-month risk. |

Client UX pillar not graded here (client side wasn't in scope).

---

## The core problem: the map is too wide and inconsistent

Today the coach console has **9 top-level groups** and **17 destinations**:

- **Today** → dashboard
- **Clients** → clients
- **Insights** → insights
- **Diagnostics & Teams** → Leader Diagnostics · Teams (Decision Room)
- **Communication** → Email Log · Client Messages · Ask Alex Log · Templates & Automation · Access & IT
- **Workshops & Assessments** → workshops
- **Organizations** → organizations
- **AI Studio** (owner-only) → aistudio
- **Settings** → Admin Accounts · Account & Security · Report Flow · AI Controls

Three specific things make this hard to hold in your head:

1. **Nine top-level tabs is past the comfortable limit** (~7). Every trip starts by scanning a wide bar.
2. **The depth is inconsistent.** Six groups jump straight to a page; three (Diagnostics & Teams, Communication, Settings) open a *second* row of sub-tabs. You can't predict whether a click lands you somewhere or just reveals more tabs. That unpredictability is most of the "where do I go" feeling.
3. **Three items are filed in the wrong drawer.** Under **Communication** you have *Access & IT* (that's help/config, not communication) and *Ask Alex Log* (that's usage analytics, not a message channel). And *Client Messages* — a daily, human, load-bearing task with an unread badge — is buried as the second sub-tab of a group instead of being one click away.

Two smaller ones: **Report Flow** and **AI Controls** (which you just built) live three and four sub-tabs deep in Settings, and you have two analytics-flavored surfaces — **Today** and **Insights** — that can blur together.

---

## Proposed simpler map (9 groups → 6)

Keep the strength (Today), promote the daily task (Messages), push the back-office logs and config into Settings where they belong.

**New top bar:** `Today · Clients · Diagnostics & Teams · Workshops · Organizations · Messages · Settings`

- **Today** — unchanged. It's the best thing here. Make it the always-on landing.
- **Clients** — people + coaching. Unchanged.
- **Diagnostics & Teams** — Leader Diagnostics · Teams (Decision Room). Unchanged.
- **Workshops** — Workshops & Assessments. Unchanged.
- **Organizations** — unchanged (real entity, keep it).
- **Messages** *(promoted to top level, keeps the unread badge)* — the one channel you touch daily should never be buried.
- **Settings** *(the back office)* — Admin Accounts · Account & Security · Templates & Automation · Report Flow · AI Controls · **Email Log · Ask Alex Log · Access & IT** (moved here from Communication). Visually cluster these into "Configuration" vs "Activity & Logs" so eight items don't read as a wall.

That removes the "Communication" grab-bag entirely, drops the top bar from 9 to 6–7, and puts the two things you touch most (Today, Messages) at the front.

---

## Fix order

### P1 — Quick wins (low risk, high relief; do these first)
1. **Move the three miscategorized items.** Pull *Access & IT* and *Ask Alex Log* out of Communication and into Settings; that alone removes the worst "why is this here" moment.
2. **Promote Client Messages to a top-level "Messages" tab** with its existing unread badge.
3. **Add a one-line descriptor (or icon) to each top-level group** so the destination is obvious before clicking, not after.
4. **Reconcile "Today" vs "Insights" naming** so it's clear which is your action list and which is analytics.

### P2 — Structural (schedule these)
5. **Consolidate to the 6–7 group map above**, including clustering Settings into Configuration / Activity & Logs.
6. **Introduce a shared style-token system (CSS variables)** to replace the scattered inline hex and spacing. This is the prerequisite for a real "premium, $10M-CEO" visual pass; you can't make it consistently beautiful while every screen hardcodes its own colors.
7. **Begin modularizing coach.html.** Not a rewrite; a gradual extraction so the file stops growing without bound.

---

## What breaks in 6 months if we don't do this

You ship features fast, and the current pattern adds a top-level tab or a buried sub-tab each time. Left alone, the nav keeps widening and the confusion compounds — the exact thing you flagged only gets worse. And the single 14,000-line file means a sub-coach or handoff engineer can't find anything without a walkthrough from you, which cuts against your leverage goal (the practice running without you in every seat). Simplifying the map now is the cheapest it will ever be.

---

## How to proceed (per the safe-build rules)

This is a review, so no code changed. When you greenlight fixes, each one goes through the normal flow: branch → preview → security check → premortem for anything structural → merge. The P1 quick wins are low-risk and I can knock them out fast; P2 items (especially the token system and modularization) deserve their own premortem before we start.

*Note: a full pixel-level visual grade (Pillar 3) needs a live look at the console under your authenticated coach session — I can't load it from here. Say the word and we'll screen-share the visual pass.*
