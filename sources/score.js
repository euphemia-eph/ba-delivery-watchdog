'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { withTimeout, shortDate } = require('../lib/util');

const MODEL = 'claude-sonnet-4-6';
const TIMEOUT_MS = 30000;

const SYSTEM_PROMPT = `You are the delivery-health analyst for Brand Alchemy, a done-for-you visibility agency. You write in Effie's voice: direct, declarative, anti-hype, no filler, no hedging, no marketing language. You assess one client account from raw ClickUp task data, delivery comments, call notes, and Slack chatter from the #delivery-management channel.

Classify the account's health flag using this judgement (these are priors, apply sense):
- red  = active refund/cancellation, churn language, repeated unanswered escalations, over-budget combined with relationship friction, a hard transparency or trust breakdown.
- amber = expectation mismatch, low response or conversion, relevance complaints, contract ending within ~45 days, a cancelled subtask, high-touch feature demands.
- green = steady delivery, no open friction.
- star  = an explicit case-study, referral, or testimonial win.

Return STRICT JSON only. No prose, no markdown, no code fences. Shape:
{
  "flag": "red" | "amber" | "green" | "star",
  "flagLabel": "2-4 word risk/status label",
  "teaser": "one declarative sentence, the headline",
  "summary": "2-4 sentences: what's happening and why it's flagged this way",
  "next": "the single next action, imperative",
  "issues": [["DD Mon", "what happened"], ...]
}

Rules:
- "issues" only for amber/red/star accounts; for green return [].
- Ground every claim in the supplied data. Do not invent specifics.
- Keep teaser/summary/next tight. Effie does not pad.`;

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** Slack messages that mention the client (by name token), with replies searched too. */
function matchSlack(clientName, messages) {
  const tokens = clientName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) tokens.push(clientName.toLowerCase());

  const hits = [];
  for (const m of messages) {
    const haystack = [m.text, ...(m.replies || []).map((r) => r.text)].join(' ').toLowerCase();
    if (tokens.some((t) => haystack.includes(t))) hits.push(m);
  }
  return hits;
}

/** Compact, readable context block for one client. */
function buildContext(c, matched) {
  const lines = [];
  lines.push(`CLIENT: ${c.name}`);
  lines.push(`ClickUp status: ${c.status}`);
  lines.push(`Tags: ${c.tags.length ? c.tags.join(', ') : 'none'}${c.overBudget ? ' (OVER BUDGET)' : ''}`);
  lines.push(`Team: ${c.assignees.length ? c.assignees.join(', ') : 'none assigned'}`);

  if (c.outstanding.length) {
    lines.push(`\nOutstanding items (${c.outstanding.length}):`);
    c.outstanding.slice(0, 20).forEach((o) => lines.push(`- ${o}`));
  }

  if (c.calls.length) {
    lines.push(`\nCall recordings:`);
    c.calls.forEach((call) => lines.push(`- ${call.when}: ${call.what}`));
  }

  const notes = c.comments.filter((cm) => cm.text.trim());
  if (notes.length) {
    lines.push(`\nClickUp comments / delivery notes:`);
    notes.slice(0, 30).forEach((cm) =>
      lines.push(`- [${shortDate(cm.date)}] ${cm.author}${cm.isBot ? ' (bot)' : ''}: ${cm.text.replace(/\s+/g, ' ').trim().slice(0, 400)}`)
    );
  }

  if (matched.length) {
    lines.push(`\nSlack #delivery-management mentions:`);
    matched.slice(0, 25).forEach((m) => {
      lines.push(`- [${shortDate(Number(m.ts) * 1000)}] ${m.author}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
      (m.replies || []).forEach((r) =>
        lines.push(`    ↳ ${r.author}: ${r.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
      );
    });
  }

  return lines.join('\n');
}

function stripFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/** Heuristic fallback if Claude is unavailable for a single client. */
function heuristic(c) {
  const blob = [
    c.status,
    c.tags.join(' '),
    ...c.comments.map((x) => x.text),
  ]
    .join(' ')
    .toLowerCase();

  let flag = 'green';
  let flagLabel = 'Steady';
  if (/cancel|refund|churn|terminat|quit|leaving/.test(blob) || c.statusType === 'closed' && /cancel/.test(c.status)) {
    flag = 'red';
    flagLabel = 'Cancellation risk';
  } else if (c.overBudget || /over budget|mismatch|complaint|unhappy|delay/.test(blob)) {
    flag = 'amber';
    flagLabel = c.overBudget ? 'Over budget' : 'Needs attention';
  }
  return {
    flag,
    flagLabel,
    teaser: `${c.name}: ${flagLabel.toLowerCase()}.`,
    summary: `Auto-classified from ClickUp signals (AI synthesis unavailable). Status "${c.status}"${c.overBudget ? ', flagged over budget' : ''}.`,
    next: 'Review manually — AI synthesis was unavailable this run.',
    issues: flag === 'green' ? [] : [[shortDate(c.date_updated), `${flagLabel} (heuristic)`]],
  };
}

/** Score one client with Claude; falls back to heuristic on per-client failure. */
async function scoreClient(c, matched) {
  const context = buildContext(c, matched);
  const msg = await withTimeout(
    client().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: context }],
    }),
    TIMEOUT_MS,
    `Claude score ${c.name}`
  );
  const text = (msg.content || []).map((b) => b.text || '').join('');
  const parsed = JSON.parse(stripFences(text));

  return {
    flag: ['red', 'amber', 'green', 'star'].includes(parsed.flag) ? parsed.flag : 'green',
    flagLabel: parsed.flagLabel || '',
    teaser: parsed.teaser || '',
    summary: parsed.summary || '',
    next: parsed.next || '',
    issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => [String(i[0] || ''), String(i[1] || '')]) : [],
  };
}

/**
 * Score every client. Returns { scored: Map<id, profile> }. Throws only if
 * EVERY client fails (signals a total Claude outage → pipeline serves stale).
 */
async function scoreAll(clients, messages) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const scored = new Map();
  let ok = 0;
  let failed = 0;

  for (const c of clients) {
    const matched = matchSlack(c.name, messages);
    try {
      scored.set(c.id, await scoreClient(c, matched));
      ok++;
    } catch (err) {
      console.warn(`[score] Claude failed for ${c.name}: ${err.message} — using heuristic`);
      scored.set(c.id, heuristic(c));
      failed++;
    }
  }

  if (clients.length > 0 && ok === 0 && failed > 0) {
    throw new Error('Claude scoring failed for all clients');
  }
  return { scored };
}

module.exports = { scoreAll, matchSlack };
