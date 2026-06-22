# Visibility Delivery Monitor

A small full-stack service that refreshes a Brand Alchemy client-health dashboard every
weekday morning. It pulls from **ClickUp**, **Slack**, and **call notes**, scores each
account with Claude, and serves a live dashboard.

This is a standalone project — it has no relationship to project-venus / vennus-audit.

## What it does

- **07:00 Europe/Lisbon, Mon–Fri**: runs the full pipeline, writes `data.json`, and
  copies it to `snapshots/YYYY-MM-DD.json` for daily diffing.
- Runs once **on boot** so the dashboard is never empty.
- Serves the dashboard at `/`, which fetches everything from `GET /api/data` on load.
- `POST /api/refresh` triggers a manual re-sync (wired to the **Re-sync** button in the
  header).

## Data pipeline (`sources/`)

| Source | File | What it captures |
| --- | --- | --- |
| ClickUp (REST v2) | `sources/clickup.js` | The active roster of `BE - Visibility` "Project Management" client tasks in the Active Projects folder; per-client status, assignees, tags (incl. **over budget**), comments (delivery notes, over-budget bot flags, **Fathom call links** from comments + threaded replies), and open subtasks / checklist items. |
| Slack (Web API) | `sources/slack.js` | Last ~14 days of `#delivery-management`, paginated, with thread replies. Uses each message's own author field (workspace user-name lookup does not resolve here). |
| Calls | — | Sourced from ClickUp comments above — no separate Fathom API needed. |

### Health scoring + profile synthesis (`sources/score.js`)

Each client's raw ClickUp data + matched Slack messages are passed to Claude
(`claude-sonnet-4-6`) with a system prompt that returns **strict JSON**. Claude
classifies health (`red` / `amber` / `green` / `star`) and writes the profile fields
(teaser, summary, next, issues) in Effie's voice. If Claude fails for a single client, a
heuristic fallback keeps the sync alive; if it fails for **all** clients, the last good
`data.json` is served with a **stale** banner.

## Output — `data.json`

The exact shape the front-end expects:

```jsonc
{
  "syncedAt": "ISO timestamp",
  "scoreboard": { "red": n, "amber": n, "green": n, "star": n, "active": n },
  "movedOvernight": [ "html-safe string", ... ],   // diff vs the most recent snapshot
  "clients": { "<slug>": { name, flag, flagLabel, team, cu, teaser, summary, next,
                           calls, issues, messages, outstanding } },
  "roster": [ [ "<slug>"|null, "<cu id>"|null, "flag", "Label", "note",
                [["Name","lead"]], "<flatName if not flagged>", "★"? ] ]
}
```

Only flagged (`red`/`amber`/`star`) clients get a full profile in `clients`. Green
accounts appear in `roster` as flat rows (`slug` null, `cu` + `flatName` set). Two extra
fields — `stale` and `unavailable` — drive the dashboard banners. An internal `_signals`
map is written for overnight diffing and stripped before it reaches the browser.

## Resilience

- Every source is wrapped in try/catch with a 10s timeout. If one fails, it's skipped,
  logged, and named in a ⚠️ banner on the dashboard.
- ClickUp calls are retried once (they intermittently fail then succeed).
- If Claude scoring fails entirely, the last good `data.json` is served with a stale
  banner. One broken source never crashes the sync.

## Security

- All keys are read from `process.env`, server-side only, and never sent to the browser.
- `.gitignore` covers `.env.local`, `.env*.local`, `.env`, `node_modules/`, `.DS_Store`,
  `data.json`, and `snapshots/`.

## Startup

1. `npm install`
2. `cp .env.example .env.local` and fill in values
3. `node server.js` → open http://localhost:3000

`npm run sync` runs the pipeline once from the CLI (no server).

### Required environment (`.env.local`)

```
ANTHROPIC_API_KEY=
CLICKUP_API_KEY=          # ClickUp personal API token (REST API v2)
SLACK_BOT_TOKEN=          # Slack bot token with channels:history for the private channel
CLICKUP_WORKSPACE_ID=9017146107
CLICKUP_ACTIVE_FOLDER=90176426081
DELIVERY_CHANNEL_ID=C08NT86F7DL
PORT=3000
TZ=Europe/Lisbon
DATA_DIR=                 # optional; set to the Railway volume mount (e.g. /data)
```

## Deploy (Railway)

1. Create a new Railway service from this repo.
2. Set the environment variables above in the service settings.
3. **Attach a volume** and set `DATA_DIR` to its mount path (e.g. `/data`). The container
   filesystem is ephemeral — the volume is what keeps `data.json` + `snapshots/` (and
   therefore daily diffing) alive across restarts.
4. Start command: `node server.js`.
