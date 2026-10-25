# Lariat Pro — Setup Guide

Lariat Pro is a full-stack, multi-market SMS + cold-email outreach platform. One server, one database, logins for every sales rep, and fully walled-off market workspaces (Land, Vegas Realtors, Homeowners, Dispo — add as many as you want).

## What's in the box

- **Markets (workspaces)** — each market has its own leads, campaigns, inbox, phone number pool, templates, quick replies, opt-out list, email identity, caps and quiet hours. A rep assigned to "Dispo" never sees "Land."
- **Team logins** — admin role (you) sees everything plus an all-markets overview; reps see only their assigned markets.
- **SMS engine (Twilio)** — multi-step drip campaigns, A/B message variants per step, spintax `{Hi|Hey|Hello}`, merge fields `{{first_name}} {{address}}` plus any custom CSV column, number-pool round-robin, per-minute throttle, per-campaign and per-market daily caps, quiet hours by market timezone, automatic stop-on-reply, automatic STOP/opt-out handling, delivery receipts.
- **Two-way inbox per market** — conversations, unread counts, quick replies, lead status pipeline (new → contacted → responded → hot → appointment → contract → closed).
- **Cold email engine** — SendGrid API (primary) with SMTP fallback (any provider), per-market From identity, sequences with the same step/variant builder, automatic unsubscribe links and List-Unsubscribe header, email opt-out list.
- **Lead manager** — CSV import with column mapping, custom fields usable in templates, dedupe by phone/email, tags, bulk enroll into campaigns.
- **Backups** — one-click full JSON export.

## 1. Run it locally (5 minutes)

Requires Node.js 22+ (nodejs.org).

```bash
cd lariat-pro
npm install
npm start
```

Open http://localhost:3000 — the first screen creates your admin account and your four starter markets.

> The database is a single file, `lariat.db`, created next to server.js. Back it up like any file.

## 2. Deploy it (so reps can log in and texts flow in 24/7)

Any Node host works. Easiest options:

**Railway** (railway.app): new project → Deploy from GitHub (or `railway up` with their CLI from this folder). Add a **volume** mounted at `/data` and set env var `DATA_DIR=/data` so the database survives redeploys. It gives you a public URL like `https://lariat-pro.up.railway.app`.

**Render** (render.com): new Web Service → build `npm install`, start `npm start`, add a persistent disk, set `DATA_DIR` to the disk path.

After deploying, open the app → **Integrations** → set **Public URL** to your deployed URL.

## 3. Connect Twilio (SMS)

1. console.twilio.com → copy **Account SID** and **Auth Token** into Integrations.
2. Buy numbers (Phone Numbers → Buy). Assign each number to a market in **Market Setup** (one per line).
3. For every number, set the **Messaging webhook** (A message comes in) to:
   `https://YOUR-PUBLIC-URL/webhooks/twilio/sms` (HTTP POST)
   That's what routes inbound texts to the right market's inbox.

### ⚠️ The 200k/month part — A2P 10DLC (do not skip)

US carriers require registration for business texting. In the Twilio console:
1. Register a **Brand** (your LLC + EIN) under Messaging → Regulatory Compliance.
2. Register a **Campaign** use case. Cold outreach is heavily scrutinized — "Low Volume" starts at 2,000–6,000 segments/day; standard campaigns go much higher with vetting.
3. Attach your numbers to the campaign via a Messaging Service.

At 200k/month (~7–10k/day) you'll want roughly **40–60 numbers** across your markets (the industry rule of thumb is 150–200 texts/day per number to protect deliverability — same thing Smarter Contact and Launch Control do behind the scenes). Spread them across markets in Market Setup and the app round-robins automatically.

Also strongly consider wholesaling-compliance basics: text only leads you have a lawful basis to contact, honor the DNC (the app auto-handles STOP), and keep quiet hours on (the app enforces them per market).

## 4. Connect email (SendGrid)

1. app.sendgrid.com → Settings → API Keys → create key with Mail Send permission → paste into Integrations.
2. Settings → Sender Authentication → **authenticate your domain** (SPF/DKIM). Cold email without domain authentication goes straight to spam.
3. In each market's Market Setup, set the From name/address for that market (e.g. `maher@lariatland.com` for Land, `maher@vegasdispo.com` for Dispo — separate domains per market protects reputations independently).

**Fallback:** leave the SendGrid key blank and fill in the SMTP section to send through any other provider (Mailgun, Google Workspace, etc.). Cold-email best practice: keep per-domain volume low (50–200/day per sending domain), warm up new domains gradually.

## 5. Daily workflow for a rep

1. Log in → their market is already selected.
2. **Leads** → Import CSV → map columns → tag the list.
3. **Campaigns** → New campaign → write step 1 (+ A/B variant), add follow-ups ("2 days later"), set throttle.
4. **Leads** → select → "Add to campaign" → back in Campaigns press **▶ Start**.
5. Live in the **Inbox**: replies pause that lead's sequence automatically; set statuses (hot/appointment/contract) as conversations develop.

## Where things live

| Thing | File |
|---|---|
| Server + API + queue engine | `server.js` |
| Entire UI | `public/index.html` |
| Database | `lariat.db` (or `$DATA_DIR/lariat.db`) |

## Troubleshooting

- **Sends fail with "Twilio not configured"** — fill in Integrations and make sure the market has numbers in Market Setup.
- **No inbound texts** — the Twilio number's webhook isn't pointed at `/webhooks/twilio/sms`, or Public URL is wrong.
- **Delivery % shows 0** — delivery receipts need the Public URL set (the app passes a StatusCallback automatically once it is).
- **Emails land in spam** — authenticate the domain in SendGrid, lower daily volume, warm up.
