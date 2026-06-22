'use strict';

const { withTimeout, retry, sleep } = require('../lib/util');

const API = 'https://slack.com/api';
const TIMEOUT_MS = 10000;
const LOOKBACK_DAYS = 14;

/** One Slack Web API GET wrapped in a 10s timeout + one retry. */
async function slackFetch(method, params) {
  const qs = new URLSearchParams(params).toString();
  return retry(
    () =>
      withTimeout(
        (async () => {
          const res = await fetch(`${API}/${method}?${qs}`, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          const json = await res.json();
          if (!json.ok) throw new Error(`Slack ${method}: ${json.error || 'unknown error'}`);
          return json;
        })(),
        TIMEOUT_MS,
        `Slack ${method}`
      ),
    2,
    `Slack ${method}`
  );
}

/**
 * The author of a message. Slack user-name lookup does not resolve team members
 * in this workspace, so we use the message's own author fields directly rather
 * than calling users.lookup.
 */
function authorOf(msg) {
  return msg.username || (msg.bot_profile && msg.bot_profile.name) || msg.user || 'unknown';
}

/** Fetch threaded replies for a parent message (skips the parent echo). */
async function getReplies(channel, ts) {
  try {
    const json = await slackFetch('conversations.replies', {
      channel,
      ts,
      limit: '100',
    });
    return (json.messages || [])
      .filter((m) => m.ts !== ts)
      .map((m) => ({ author: authorOf(m), text: m.text || '', ts: m.ts }));
  } catch (err) {
    console.warn(`[slack] replies failed for ${ts}: ${err.message}`);
    return [];
  }
}

/**
 * Read the last ~14 days of the delivery channel, paginated, with thread
 * replies folded in. Returns newest-first.
 */
async function fetchSlack() {
  const channel = process.env.DELIVERY_CHANNEL_ID;
  const oldest = String(Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400);

  const messages = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const params = { channel, oldest, limit: '200' };
    if (cursor) params.cursor = cursor;
    const json = await slackFetch('conversations.history', params);

    for (const m of json.messages || []) {
      if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;
      const entry = {
        author: authorOf(m),
        text: m.text || '',
        ts: m.ts,
        replies: [],
      };
      if (m.reply_count > 0 && m.thread_ts) {
        entry.replies = await getReplies(channel, m.thread_ts);
      }
      messages.push(entry);
    }

    cursor = json.response_metadata && json.response_metadata.next_cursor;
    if (!cursor) break;
    await sleep(150);
  }

  messages.sort((a, b) => Number(b.ts) - Number(a.ts));
  return { messages };
}

module.exports = { fetchSlack };
