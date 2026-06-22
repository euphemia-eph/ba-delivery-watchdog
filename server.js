'use strict';

const fs = require('fs');
const path = require('path');

// Load server-side secrets from .env.local (never committed, never sent to client).
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const express = require('express');
const cron = require('node-cron');
const { runPipeline, readData, dataFile } = require('./lib/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Lisbon';

app.use(express.static(path.join(__dirname, 'public')));

// Empty skeleton so the dashboard renders cleanly before the first sync lands.
const EMPTY = {
  syncedAt: null,
  scoreboard: { red: 0, amber: 0, green: 0, star: 0, active: 0 },
  movedOvernight: [],
  clients: {},
  roster: [],
  stale: false,
  unavailable: [],
};

app.get('/api/data', (_req, res) => {
  const data = readData() || EMPTY;
  // Strip the internal diffing map before it reaches the browser.
  const { _signals, ...publicData } = data;
  res.json(publicData);
});

let syncing = false;
app.post('/api/refresh', async (_req, res) => {
  if (syncing) return res.status(409).json({ ok: false, error: 'A sync is already running.' });
  syncing = true;
  try {
    const data = await runPipeline();
    res.json({ ok: true, syncedAt: data.syncedAt, scoreboard: data.scoreboard, unavailable: data.unavailable });
  } catch (err) {
    console.error('[server] manual refresh failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    syncing = false;
  }
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, hasData: fs.existsSync(dataFile()) });
});

async function safeSync(reason) {
  if (syncing) {
    console.log(`[server] sync skipped (${reason}) — already running`);
    return;
  }
  syncing = true;
  try {
    console.log(`[server] sync triggered: ${reason}`);
    await runPipeline();
  } catch (err) {
    console.error(`[server] sync (${reason}) failed:`, err.message);
  } finally {
    syncing = false;
  }
}

app.listen(PORT, () => {
  console.log(`Visibility Delivery Monitor listening on http://localhost:${PORT} (TZ=${TZ})`);

  // 07:00 Europe/Lisbon, Monday–Friday.
  cron.schedule('0 7 * * 1-5', () => safeSync('cron 07:00 weekday'), { timezone: TZ });

  // Run once on boot so the dashboard is never empty.
  safeSync('boot');
});
