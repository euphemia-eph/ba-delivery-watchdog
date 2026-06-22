'use strict';

/**
 * Run a promise-returning fn with a hard timeout. Rejects if it doesn't settle
 * in `ms`. Used to wrap every external source so one slow API can't hang sync.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retry an async fn once on failure (ClickUp intermittently errors then
 * succeeds). `attempts` is the total number of tries.
 */
async function retry(fn, attempts = 2, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`[retry] ${label || 'call'} failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      }
    }
  }
  throw lastErr;
}

/** Sleep helper for pacing paginated/rate-limited API loops. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn a client name into a stable slug used as the key in data.json.clients. */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Escape a string so it is safe to drop into HTML text content. */
function htmlSafe(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a ms-epoch (number or numeric string) as "DD Mon" in Lisbon time. */
function shortDate(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  try {
    return new Date(n).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: process.env.TZ || 'Europe/Lisbon',
    });
  } catch {
    return '';
  }
}

/** All Fathom (or generic call-recording) share/call URLs found in a blob of text. */
function extractCallLinks(text) {
  if (!text) return [];
  const out = [];
  const re = /https?:\/\/[^\s)<>"']+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,)]+$/, '');
    if (/fathom\.video|\/share\/|\/calls\//i.test(url)) out.push(url);
  }
  return out;
}

module.exports = { withTimeout, retry, sleep, slugify, htmlSafe, shortDate, extractCallLinks };
