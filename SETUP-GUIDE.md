# GPS Leadership — 90-Day Portal: EA Setup Guide

This is the complete step-by-step guide to get the portal live. Follow in order. Estimated total time: 2–3 hours the first time.

---

## What You're Building

- **client.html** — the client-facing portal. Each client gets a unique URL. No password needed.
- **coach.html** — Alex's private dashboard to see all clients, check-ins, and progress. Password protected.
- **api/notify.js** — automatic email to Alex every time a client submits anything.

---

## Step 1 — Supabase (the database) — 20 minutes

Supabase stores all client data and check-ins. Free. No credit card required for this scale.

1. Go to **https://supabase.com** and create a free account.
2. Click **"New Project"**. Name it `gps-portal`. Choose any region. Set a database password and save it somewhere.
3. Wait ~2 minutes for the project to initialize.
4. In the left sidebar, click **"SQL Editor"** → **"New query"**.
5. Open the file `supabase-setup.sql` from this folder. Copy the entire contents. Paste into the SQL editor. Click **"Run"**.
6. You should see "Success" with no errors. This creates the `clients` and `checkins` tables.
7. Go to **Settings → API** (left sidebar).
8. Copy two values — you'll need them in Step 3:
   - **Project URL** (looks like `https://xyzabc.supabase.co`)
   - **anon public key** (a long string starting with `eyJ…`)

---

## Step 2 — Resend (email notifications) — 15 minutes

Resend sends the notification emails to Alex. Free up to 100 emails/day.

1. Go to **https://resend.com** and create a free account.
2. Click **"Domains"** → **"Add Domain"**. Enter `gpsleadership.org`.
3. Resend will show you DNS records to add. Log into your domain registrar (wherever gpsleadership.org is hosted — GoDaddy, Namecheap, etc.) and add those DNS records.
4. Click **"Verify"** in Resend. DNS can take 15–60 minutes to propagate. Come back and verify.
5. Once verified, go to **"API Keys"** → **"Create API Key"**. Name it `gps-portal`. Copy the key — you'll need it in Step 3.

> If you want to skip email for now: comment out the `fetch(NOTIFY_URL, ...)` blocks in client.html. Alex will use the coach dashboard instead to check on clients.

---

## Step 3 — Configure the app files — 10 minutes

You need to fill in three configuration values in two files.

### In `client.html` — find this block near the bottom:
```
const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
```
Replace with your actual values from Step 1.

### In `coach.html` — find this block:
```
const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
const COACH_PASSWORD = 'GPS2026';
const PORTAL_BASE_URL = 'https://YOUR_DOMAIN/client.html';
```
- Replace SUPABASE values from Step 1.
- Change `GPS2026` to a password Alex will remember.
- Replace `YOUR_DOMAIN` with the actual domain once you have it (e.g., `portal.gpsleadership.org`).

### In `api/notify.js` — find this block:
```
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL     = 'noreply@gpsleadership.org';
```
This file reads the API key from an environment variable — you'll set that in Vercel (Step 4). Leave this file as-is.

---

## Step 4 — Vercel (hosting) — 20 minutes

Vercel hosts the portal files and runs the notification function. Free.

1. Go to **https://vercel.com** and create a free account (sign up with GitHub — easiest).
2. If you don't have GitHub: create a free account at **https://github.com** first.
3. In GitHub, create a new repository called `gps-portal`. Upload all files from this folder:
   - `client.html`
   - `coach.html`
   - `vercel.json`
   - `api/notify.js` (the `api` folder with the file inside it)
4. In Vercel, click **"Add New Project"** → connect your GitHub account → select `gps-portal`.
5. Click **"Deploy"** — Vercel builds and deploys automatically. Takes ~1 minute.
6. Once deployed, go to **Project Settings → Environment Variables** and add:
   - Key: `RESEND_API_KEY`
   - Value: (your Resend API key from Step 2)
   - Click **Save**.
7. Go to **Deployments** → click **"Redeploy"** (top right) so it picks up the new env variable.

Your portal is now live at a Vercel URL like `gps-portal-abc123.vercel.app`.

---

## Step 5 — Connect a custom domain (optional) — 20 minutes

Skip this step initially and use the Vercel URL for testing. Do this when ready to send to real clients.

1. Decide on the subdomain: `portal.gpsleadership.org` is clean and professional.
2. In Vercel → Project → **Settings → Domains** → add `portal.gpsleadership.org`.
3. Vercel will show a DNS record to add. Log into your domain registrar and add it as a CNAME record.
4. DNS propagates in 15–60 minutes. Vercel will confirm when it's active.
5. Once live, update `PORTAL_BASE_URL` in `coach.html` to the real domain and redeploy.

---

## Step 6 — Test end to end — 20 minutes

Before sending to any real client, run through this full test:

1. Open `coach.html` in your browser. Log in with the password you set.
2. Click **"+ Add Client"**. Add a test client with your own name and email.
3. A portal URL will appear. Copy it. Open it in a new private/incognito window.
4. Complete Form B (the plan setup). Submit.
5. Alex should receive a "New 90-Day Plan" email within 30 seconds.
6. Refresh the incognito window. You should now see the portal with the plan and the Week 1 check-in form.
7. Complete the check-in. Submit.
8. Alex should receive a "Week 1 Check-In" summary email.
9. Back in the coach dashboard, verify the client shows updated data.
10. In the coach dashboard, click "Mark as Complete" to test the deactivation flow.

If all 10 steps work: you're ready to go live.

---

## Step 7 — Adding real clients

Once live, the workflow for each new 90-day client is:

1. Open `coach.html` and log in.
2. Click **"+ Add Client"**. Enter name, email (optional), organization.
3. Copy the portal URL that appears.
4. Email that URL to the client (can use your existing email — just paste the link).
5. Tell them: "This is your 90-day plan portal. Bookmark it. You'll use it every week. Step 1 is to log in and lock in your plan — takes 10 minutes."

That's it. No passwords for them. No IT setup. Just a link.

---

## Ongoing Maintenance

| Task | Who | When |
|------|-----|------|
| Add new client | EA | After each debrief |
| Mark client complete | EA | Week 13 or when engagement ends |
| Check notification emails | Alex | Real-time (automatic) |
| Review coach dashboard | Alex | Before each coaching call |
| Update files if needed | EA (with Claude's help) | As needed |

---

## Troubleshooting

**Client gets "Link not recognized" error:**
The token in the URL doesn't match any client record. Double-check the URL was copied correctly from the coach dashboard. If lost, open the coach dashboard, find the client, and copy their URL again.

**Email notifications not arriving:**
Check the Resend dashboard (resend.com → Logs) to see if sends are failing. Most common cause: domain not fully verified. Also check Alex's spam folder.

**"Something went wrong" error on the client portal:**
Usually a Supabase connection issue. Check that `SUPABASE_URL` and `SUPABASE_ANON` in client.html are correct and the Supabase project is active.

**Coach dashboard shows no clients:**
Same config issue — verify Supabase credentials in coach.html and that the SQL setup ran without errors.

---

## File Summary

| File | Purpose |
|------|---------|
| `client.html` | Client-facing portal — plan setup + weekly check-ins |
| `coach.html` | Alex's dashboard — all clients, all data |
| `api/notify.js` | Email notification function |
| `supabase-setup.sql` | Database schema — run once in Supabase |
| `vercel.json` | Vercel routing config |
| `SETUP-GUIDE.md` | This document |

---

*Built for GPS Leadership Solutions. Questions: ask Claude.*
