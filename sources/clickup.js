'use strict';

const { withTimeout, retry, sleep, shortDate, extractCallLinks } = require('../lib/util');

const API = 'https://api.clickup.com/api/v2';
const TIMEOUT_MS = 10000;
const TASK_TYPE_NAME = 'BE - Visibility';

function headers() {
  return { Authorization: process.env.CLICKUP_API_KEY, 'Content-Type': 'application/json' };
}

/**
 * One ClickUp REST call wrapped in a 10s timeout and retried once (ClickUp
 * intermittently fails once then succeeds). Throws on non-2xx.
 */
async function cuFetch(path) {
  return retry(
    () =>
      withTimeout(
        (async () => {
          const res = await fetch(`${API}${path}`, { headers: headers() });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`ClickUp ${res.status} on ${path}: ${body.slice(0, 200)}`);
          }
          return res.json();
        })(),
        TIMEOUT_MS,
        `ClickUp ${path}`
      ),
    2,
    `ClickUp ${path}`
  );
}

/** Resolve the numeric custom_item_id behind the "BE - Visibility" task type. */
async function resolveVisibilityTypeId() {
  try {
    const data = await cuFetch(`/team/${process.env.CLICKUP_WORKSPACE_ID}/custom_item`);
    const items = data.custom_items || [];
    const match = items.find(
      (i) => (i.name || '').trim().toLowerCase() === TASK_TYPE_NAME.toLowerCase()
    );
    return match ? match.id : null;
  } catch (err) {
    console.warn(`[clickup] could not resolve custom task types: ${err.message}`);
    return null;
  }
}

/** Map a numeric custom_item_id back to a readable type name where possible. */
function typeName(customItemId, typeMap) {
  if (customItemId == null) return 'Task';
  return typeMap.get(customItemId) || `type:${customItemId}`;
}

/**
 * Page through every task in the active folder. ClickUp's paginated team-task
 * endpoint loops back to the start once the full set is returned, so we stop as
 * soon as a page introduces no new task ids (per the documented behaviour).
 */
async function getFolderTasks(folderId) {
  const seen = new Set();
  const all = [];
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      page: String(page),
      subtasks: 'true',
      include_closed: 'true',
      order_by: 'updated',
    });
    qs.append('project_ids[]', folderId); // project_ids = folders in v2
    const data = await cuFetch(`/team/${process.env.CLICKUP_WORKSPACE_ID}/task?${qs.toString()}`);
    const tasks = data.tasks || [];
    if (tasks.length === 0) break;
    let added = 0;
    for (const t of tasks) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        all.push(t);
        added++;
      }
    }
    if (added === 0) break; // looped back to duplicates → full set retrieved
    if (data.last_page) break;
    await sleep(120);
  }
  return all;
}

/** Comments for a task, with threaded replies folded in. Each entry is normalised. */
async function getTaskComments(taskId) {
  let data;
  try {
    data = await cuFetch(`/task/${taskId}/comment`);
  } catch (err) {
    console.warn(`[clickup] comments failed for ${taskId}: ${err.message}`);
    return [];
  }
  const comments = data.comments || [];
  const out = [];
  for (const c of comments) {
    const text = c.comment_text || '';
    const author = (c.user && c.user.username) || 'Unknown';
    out.push({
      author,
      text,
      date: c.date,
      links: extractCallLinks(text),
      isBot: c.user && (c.user.id === -1 || /clickbot|nova/i.test(author)),
    });

    if (c.reply_count > 0) {
      try {
        const rep = await cuFetch(`/comment/${c.id}/reply`);
        for (const r of rep.comments || []) {
          const rt = r.comment_text || '';
          out.push({
            author: (r.user && r.user.username) || 'Unknown',
            text: rt,
            date: r.date,
            links: extractCallLinks(rt),
            isBot: r.user && (r.user.id === -1 || /clickbot|nova/i.test(r.user.username || '')),
          });
        }
      } catch (err) {
        console.warn(`[clickup] replies failed for comment ${c.id}: ${err.message}`);
      }
    }
  }
  return out;
}

/** Full task detail → subtasks + checklist items, used for "outstanding items". */
async function getOutstanding(taskId) {
  let data;
  try {
    data = await cuFetch(`/task/${taskId}?include_subtasks=true`);
  } catch (err) {
    console.warn(`[clickup] detail failed for ${taskId}: ${err.message}`);
    return [];
  }
  const outstanding = [];
  const OPEN = (s) => s && !['complete', 'closed', 'done'].includes(String(s).toLowerCase());

  for (const sub of data.subtasks || []) {
    const status = sub.status && sub.status.status;
    const type = (sub.status && sub.status.type) || '';
    if (OPEN(status) && type !== 'closed' && type !== 'done') {
      outstanding.push(sub.name);
    }
  }
  for (const cl of data.checklists || []) {
    for (const item of cl.items || []) {
      if (!item.resolved) outstanding.push(item.name);
    }
  }
  return outstanding;
}

/**
 * Top-level: resolve the active roster of "BE - Visibility" client tasks and,
 * for each, pull comments (delivery notes, over-budget flags, Fathom call
 * links) and open subtasks/checklist items.
 */
async function fetchClickUp() {
  const folderId = process.env.CLICKUP_ACTIVE_FOLDER;
  const visTypeId = await resolveVisibilityTypeId();

  // Build a custom_item_id -> name map for readable task_type labels.
  let typeMap = new Map();
  try {
    const ci = await cuFetch(`/team/${process.env.CLICKUP_WORKSPACE_ID}/custom_item`);
    typeMap = new Map((ci.custom_items || []).map((i) => [i.id, i.name]));
  } catch {
    /* non-fatal */
  }

  const tasks = await getFolderTasks(folderId);

  // A client = a "Project Management" task of type "BE - Visibility".
  const clientTasks = tasks.filter((t) => {
    const name = (t.name || '').toLowerCase();
    const isPM = /project management/.test(name) && !/hours/.test(name);
    if (!isPM) return false;
    if (/insert client name/.test(name)) return false; // template
    if (visTypeId != null) return t.custom_item_id === visTypeId;
    return true; // fallback when custom types can't be resolved
  });

  const clients = [];
  for (const t of clientTasks) {
    const cleanName =
      (t.name || '').replace(/\s*[-–]\s*Project Management\s*$/i, '').trim() ||
      (t.list && t.list.name) ||
      t.name;

    const tags = (t.tags || []).map((tag) => tag.name);
    const overBudget = tags.some((n) => /over budget/i.test(n));

    const [comments, outstanding] = await Promise.all([
      getTaskComments(t.id),
      getOutstanding(t.id),
    ]);

    // Calls = comments that carry a recording link.
    const calls = [];
    for (const c of comments) {
      for (const link of c.links) {
        const note = c.text.replace(link, '').replace(/\s+/g, ' ').trim();
        calls.push({ when: shortDate(c.date), what: note ? `${note} — ${link}` : link, date: c.date });
      }
    }

    clients.push({
      id: t.id,
      name: cleanName,
      status: (t.status && t.status.status) || 'unknown',
      statusType: (t.status && t.status.type) || '',
      task_type: typeName(t.custom_item_id, typeMap),
      assignees: (t.assignees || []).map((a) => a.username),
      tags,
      overBudget,
      date_updated: t.date_updated,
      comments,
      calls,
      outstanding,
    });
  }

  return { clients, resolvedType: visTypeId != null };
}

module.exports = { fetchClickUp };
