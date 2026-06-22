# Handover — Visibility Delivery Monitor

**For:** the Brand Alchemy developer taking ownership of hosting.
**Repo:** `euphemia-eph/ba-delivery-watchdog` (branch `main`)
**What it is:** a Node/Express service that rebuilds a client-health dashboard every
weekday morning from ClickUp + Slack + call notes, scores each account with Claude, and
serves a live dashboard. Full architecture is in [`README.md`](./README.md).

This document is everything you need to host it on **Brand Alchemy's own Railway account
and credentials**. It should host on BA infrastructure, not a personal account.

---

## 1. What you're inheriting

- The code is complete, committed to `main`, and runs as-is.
- It was smoke-tested on a personal Railway trial to validate the deploy. **That trial
  service should be deleted** once BA's is live — don't keep two running.
- **Known open item:** the ClickUp API token used in the test was rejected with
  `401 Token invalid` (OAUTH_025). You'll supply a valid BA-owned token (see §3). Slack
  and Anthropic connected fine in testing.

## 2. Prerequisites

- A **Brand Alchemy Railway account** (railway.com). Realistic cost: the **Hobby plan
  (~$5/mo)** — the service is always-on and runs a daily cron, so the free trial isn't
  sufficient long term.
- Access to generate three credentials (§3). These can be BA service accounts; they don't
  have to be a specific person, but the **ClickUp** token must belong to an account that
  is a member of the Brand Alchemy ClickUp workspace.
- GitHub access to the repo (to connect it to Railway, and for future changes).

## 3. Credentials required

All three are **secrets** — set them as Railway service variables, never commit them. The
repo's [`.env.example`](./.env.example) lists every variable.

| Variable | What it is | How to get it / required scope |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key (model `claude-sonnet-4-6`) for scoring/synthesis | console.anthropic.com → API Keys → Create Key. Needs billing enabled. |
| `CLICKUP_API_KEY` | ClickUp **personal API token**, REST API v2 | ClickUp → avatar → **Settings → Apps → API Token**. Value starts with `pk_` and is the *whole* string (≈50 chars). **The owning account must be a member of workspace `9017146107`.** A token from a non-member returns `401`/`403`. |
| `SLACK_BOT_TOKEN` | Slack **bot** token (`xoxb-…`) | api.slack.com/apps → your app → **OAuth & Permissions**. Scopes: **`channels:history`** and, because `#delivery-management` is private, **`groups:history`**. Then **invite the bot into `#delivery-management`** (`/invite @yourbot`) or it reads nothing. |

### Non-secret config (already correct in `.env.example` — copy as-is)

| Variable | Value | Meaning |
| --- | --- | --- |
| `CLICKUP_WORKSPACE_ID` | `9017146107` | Brand Alchemy workspace |
| `CLICKUP_ACTIVE_FOLDER` | `90176426081` | Active Projects category |
| `DELIVERY_CHANNEL_ID` | `C08NT86F7DL` | `#delivery-management` |
| `TZ` | `Europe/Lisbon` | Cron timezone |
| `DATA_DIR` | `/data` | Must match the mounted volume path (§4) |

> Do **not** set `PORT` — Railway injects it automatically and the app reads `process.env.PORT`.

## 4. Deploy to Railway (BA account)

1. railway.com → **New Project → Deploy from GitHub repo** → select
   `euphemia-eph/ba-delivery-watchdog` (deploys from `main`). Install the Railway GitHub
   app for the repo if prompted.
2. **Variables** tab → add the 8 variables from §3 (3 secrets + 5 config). The repo's
   `railway.json` / `Procfile` already set the build (Nixpacks) and start command
   (`node server.js`), so no build config is needed.
3. **Attach a Volume**: right-click the service canvas → **Attach Volume** → mount path
   **`/data`** (must equal `DATA_DIR`). This persists `data.json` + `snapshots/` across
   restarts — without it the dashboard and daily diffing reset on every redeploy.
4. **Deploy.**
5. **Settings → Networking → Generate Domain** → that URL is what the team uses.

## 5. Verify it's healthy

Open the service → **Deployments → View Logs**. A good boot shows:

```
Visibility Delivery Monitor listening on http://localhost:<port> (TZ=Europe/Lisbon)
[server] sync triggered: boot
[pipeline] sync started ...
[pipeline] sync done: N clients, x🔴 x🟠 x🟢 x⭐
```

Then load the domain — the header shows "Last synced …", the scoreboard is populated, and
flagged accounts render as cards with the green roster below. `GET /healthz` returns
`{"ok":true,...}` for uptime checks.

## 6. How it runs

- **Schedule:** `node-cron` at **07:00 Europe/Lisbon, Mon–Fri** runs the full pipeline.
- **On boot:** runs once immediately so the dashboard is never empty.
- **Manual:** the **Re-sync** button in the dashboard header → `POST /api/refresh`.
- **Persistence:** writes `data.json` and `snapshots/YYYY-MM-DD.json` under `DATA_DIR`.

## 7. Resilience model (so logs make sense)

Each source is isolated with a 10s-per-call timeout; ClickUp calls retry once. If a source
fails, the sync continues and the dashboard shows a ⚠️ banner naming it. If Claude scoring
fails entirely, the last good `data.json` is served with a "stale" banner. One broken
source never crashes the service.

## 8. Troubleshooting

| Symptom (in logs / banner) | Cause | Fix |
| --- | --- | --- |
| `ClickUp 401 … Token invalid (OAUTH_025)` | Bad/incomplete `CLICKUP_API_KEY` | Re-paste the full `pk_…` token, no spaces/quotes; or regenerate in ClickUp. |
| `ClickUp 403` | Token valid but account isn't in workspace `9017146107` | Use a token from a workspace member. |
| Banner: "sources unavailable: Slack" but ClickUp works | Bot not in channel, or missing scope | Invite the bot to `#delivery-management`; add `channels:history` + `groups:history`; reinstall the app. |
| `timed out after …ms` on ClickUp | Very large pull exceeded the budget | Raise the ClickUp source budget / parallelize per-client calls in `lib/pipeline.js` + `sources/clickup.js`. |
| Red "stale" banner | Claude scoring failed (e.g. bad/no `ANTHROPIC_API_KEY`, billing) | Check the Anthropic key + account billing; serves last good data until fixed. |
| Dashboard empties after a redeploy | No volume, or `DATA_DIR` ≠ mount path | Attach a volume at `/data` and set `DATA_DIR=/data`. |

## 9. Local development

```
npm install
cp .env.example .env.local   # fill in the three secrets
node server.js               # http://localhost:3000
npm run sync                 # run the pipeline once from the CLI, no server
```

`.env.local`, `data.json`, and `snapshots/` are gitignored — secrets never reach the repo.

## 10. Where to change things

| Want to change… | File |
| --- | --- |
| ClickUp roster resolution, comments, call-link parsing, subtasks | `sources/clickup.js` |
| Slack channel read / pagination / author handling | `sources/slack.js` |
| Health rules, system prompt, JSON schema, Effie's voice | `sources/score.js` |
| Pipeline assembly, overnight diffing, persistence paths | `lib/pipeline.js` |
| Schedule, routes, boot behaviour | `server.js` |
| Dashboard look & rendering | `public/index.html` |
| The Claude model | `MODEL` constant in `sources/score.js` (`claude-sonnet-4-6`) |
