'use strict';

const fs = require('fs');
const path = require('path');
const { withTimeout, slugify, htmlSafe } = require('./util');
const { fetchClickUp } = require('../sources/clickup');
const { fetchSlack } = require('../sources/slack');
const { scoreAll, matchSlack } = require('../sources/score');

const SOURCE_TIMEOUT_MS = 10000;
const FLAG_ORDER = { red: 0, amber: 1, star: 2, green: 3 };

function dataDir() {
  return process.env.DATA_DIR && process.env.DATA_DIR.trim()
    ? process.env.DATA_DIR.trim()
    : path.join(__dirname, '..');
}
const dataFile = () => path.join(dataDir(), 'data.json');
const snapDir = () => path.join(dataDir(), 'snapshots');

function ensureDirs() {
  fs.mkdirSync(snapDir(), { recursive: true });
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** Most recent snapshot strictly before today (for overnight diffing). */
function latestSnapshotBefore(today) {
  try {
    const files = fs
      .readdirSync(snapDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < today)
      .sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(snapDir(), files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

/** Wrap a source so a failure/timeout is isolated and reported, never thrown up. */
async function runSource(label, fn, fallback, warnings) {
  try {
    return await withTimeout(fn(), SOURCE_TIMEOUT_MS + 25000, label);
  } catch (err) {
    console.error(`[pipeline] source "${label}" failed: ${err.message}`);
    warnings.push(label);
    return fallback;
  }
}

function teamFrom(assignees) {
  return assignees.map((name, i) => [name, i === 0 ? 'lead' : '']);
}

function buildClientProfile(c, profile, messages) {
  const matched = matchSlack(c.name, messages);
  return {
    name: c.name,
    flag: profile.flag,
    flagLabel: profile.flagLabel,
    team: teamFrom(c.assignees),
    cu: c.id,
    teaser: profile.teaser,
    summary: profile.summary,
    next: profile.next,
    calls: c.calls.map((call) => [call.when, call.what]),
    issues: profile.issues,
    messages: matched
      .slice(0, 12)
      .map((m) => [`${m.author} · ${require('./util').shortDate(Number(m.ts) * 1000)}`, m.text.replace(/\s+/g, ' ').trim()]),
    outstanding: c.outstanding.map((o) => [o, false]),
  };
}

/** Build the exact data.json shape the front-end expects. */
function assemble({ clients, profiles, messages, warnings, stale }) {
  const scoreboard = { red: 0, amber: 0, green: 0, star: 0, active: clients.length };
  const clientsObj = {};
  const roster = [];
  const signals = {}; // internal: per-cu flag/status for overnight diffing

  // Sort flagged-first, then alphabetical, for a stable roster.
  const ordered = clients
    .map((c) => ({ c, p: profiles.get(c.id) }))
    .sort((a, b) => {
      const fa = FLAG_ORDER[a.p.flag] ?? 9;
      const fb = FLAG_ORDER[b.p.flag] ?? 9;
      return fa - fb || a.c.name.localeCompare(b.c.name);
    });

  for (const { c, p } of ordered) {
    scoreboard[p.flag] = (scoreboard[p.flag] || 0) + 1;
    signals[c.id] = { name: c.name, flag: p.flag, status: c.status, overBudget: c.overBudget };

    const flagged = p.flag !== 'green';
    if (flagged) {
      const slug = slugify(c.name);
      clientsObj[slug] = buildClientProfile(c, p, messages);
      roster.push([
        slug,
        c.id,
        p.flag,
        p.flagLabel || '',
        c.overBudget ? 'over budget' : '',
        teamFrom(c.assignees),
        '',
        p.flag === 'star' ? '★' : '',
      ]);
    } else {
      roster.push([
        null,
        c.id,
        'green',
        '',
        c.overBudget ? 'over budget' : c.status,
        teamFrom(c.assignees),
        c.name,
        '',
      ]);
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    scoreboard,
    movedOvernight: [],
    clients: clientsObj,
    roster,
    stale: !!stale,
    unavailable: warnings,
    _signals: signals,
  };
}

/** Compare today's signals against the most recent prior snapshot. */
function computeMovedOvernight(today, prev) {
  if (!prev || !prev._signals) {
    return ['First sync — no prior snapshot to compare against.'];
  }
  const lines = [];
  const now = today._signals || {};
  const before = prev._signals || {};
  const labelFlag = { red: 'red', amber: 'amber', green: 'green', star: 'star' };

  for (const [cu, cur] of Object.entries(now)) {
    const old = before[cu];
    if (!old) {
      lines.push(`New account on the board: ${cur.name} (${labelFlag[cur.flag]}).`);
      continue;
    }
    if (old.flag !== cur.flag) {
      lines.push(`${cur.name} moved ${labelFlag[old.flag]} → ${labelFlag[cur.flag]}.`);
    }
    if (!old.overBudget && cur.overBudget) {
      lines.push(`${cur.name} tagged over budget overnight.`);
    }
    if (!/cancel/i.test(old.status || '') && /cancel/i.test(cur.status || '')) {
      lines.push(`${cur.name} — cancellation/churn signal on the ClickUp status.`);
    }
  }
  for (const [cu, old] of Object.entries(before)) {
    if (!now[cu]) lines.push(`${old.name} dropped off the active roster.`);
  }

  return lines.map(htmlSafe);
}

/**
 * Full pipeline: pull each source (isolated), score with Claude, assemble
 * data.json, diff against yesterday, persist + snapshot. On total Claude
 * failure, keep the last good data.json and mark it stale.
 */
async function runPipeline() {
  ensureDirs();
  const warnings = [];
  const startedAt = new Date().toISOString();
  console.log(`[pipeline] sync started ${startedAt}`);

  const cu = await runSource('ClickUp', fetchClickUp, { clients: [] }, warnings);
  const slack = await runSource('Slack', fetchSlack, { messages: [] }, warnings);

  const clients = cu.clients || [];
  const messages = slack.messages || [];

  if (clients.length === 0) {
    // No client data at all — keep last good if present rather than blanking out.
    const last = readData();
    if (last) {
      last.stale = true;
      last.unavailable = Array.from(new Set([...(last.unavailable || []), ...warnings]));
      writeData(last);
      console.warn('[pipeline] no ClickUp clients resolved — served last good data (stale).');
      return last;
    }
  }

  let profiles;
  try {
    ({ scored: profiles } = await scoreAll(clients, messages));
  } catch (err) {
    console.error(`[pipeline] scoring (Claude) failed entirely: ${err.message}`);
    const last = readData();
    if (last) {
      last.stale = true;
      last.unavailable = Array.from(new Set([...(last.unavailable || []), 'AI synthesis']));
      writeData(last);
      return last;
    }
    // No prior good data: classify minimally so the UI isn't broken.
    profiles = new Map(
      clients.map((c) => [
        c.id,
        {
          flag: c.overBudget ? 'amber' : 'green',
          flagLabel: c.overBudget ? 'Over budget' : '',
          teaser: '',
          summary: 'AI synthesis was unavailable this run.',
          next: 'Re-sync once AI synthesis is available.',
          issues: [],
        },
      ])
    );
    warnings.push('AI synthesis');
  }

  const data = assemble({ clients, profiles, messages, warnings, stale: warnings.includes('AI synthesis') });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Europe/Lisbon' });
  const prev = latestSnapshotBefore(today);
  data.movedOvernight = computeMovedOvernight(data, prev);

  writeData(data);
  fs.writeFileSync(path.join(snapDir(), `${today}.json`), JSON.stringify(data, null, 2));
  console.log(
    `[pipeline] sync done: ${clients.length} clients, ${data.scoreboard.red}🔴 ${data.scoreboard.amber}🟠 ${data.scoreboard.green}🟢 ${data.scoreboard.star}⭐` +
      (warnings.length ? ` — unavailable: ${warnings.join(', ')}` : '')
  );
  return data;
}

function writeData(data) {
  ensureDirs();
  fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2));
}

module.exports = { runPipeline, readData, dataFile, snapDir, dataDir };
