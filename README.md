# AV Service Report — hosted dashboard

A web dashboard that pulls your AV cases and health checks from SafetyCulture
and shows them as a clean, client-friendly monthly report with a **Download PDF**
button. It runs as a small server that keeps your API key private.

Until a key is added it shows **sample data**, so you can see it working first.

---

## Putting it online (easiest path: Render — free tier)

You do this part because it runs under your account with your secret key.
It's about 10 minutes, once.

1. Make a free account at **render.com**.
2. Put this folder on **GitHub** (a public or private repo is fine). If you've
   never used GitHub, the GitHub Desktop app does it with a few clicks.
3. In Render: **New > Web Service**, connect that repo. Render reads the included
   `render.yaml` and fills in the settings automatically — just click create.
4. In the new service, open **Environment** and add one variable:
   - Key: `SC_API_TOKEN`
   - Value: your SafetyCulture token (see below)
5. Save. Render redeploys, and you get a live web link like
   `https://av-sla-dashboard.onrender.com`. That's the link you share.

**Your token is only ever pasted into Render's settings — never into the code,
the repo, or a chat.**

### Getting your SafetyCulture token
In SafetyCulture: click your **organisation name** (bottom-left) > **Integrations**
> **API tokens** > create a **Service user token**. Copy it into Render as above.
(API access needs a Premium or Enterprise SafetyCulture plan.)

---

## Run it on your own computer first (optional, to try it)

With Node.js (v18+) installed, in this folder:

```
npm install
npm start
```

Open http://localhost:3000 — sample data shows immediately. To see your real data
locally, set the key first: `SC_API_TOKEN=your_token npm start`.

---

## The one thing to check after the first live load

When real data loads, the green bar at the top lists the **priority** and **status**
words it found in your SafetyCulture account. Open `server.js` and look at the
`CONFIG` block near the top — it's the only part you might need to touch. It maps:

- each SafetyCulture **priority** to a fault category (Room Down / Partial Fault / Routine)
- which **status** words mean "closed"
- your two inspection **template IDs** (for health-check counts)

If the words in the green bar already match, you're done. If not, copy them into
`CONFIG` and redeploy. Everything else is automatic.

## Not included yet (these need more than the API gives)
- Phone-call count (SafetyCulture doesn't capture these — kept separate)
- Service-improvement actions (manager-maintained — easy add later)
- Asset register / QR (you're keeping that manual for now)
