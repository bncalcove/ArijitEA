import { callJSON, aiEnabled } from '../integrations/anthropic.js';
import { CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, classifyUser, render, nowIstString } from './prompts.js';
import { all, one, insert, get, readRoles, readProjects, nowIso } from '../db.js';

export const REVIEW_THRESHOLD = 0.6;

function isAri(name) {
  if (!name) return false;
  const me = readRoles().me || {};
  const n = name.trim().toLowerCase();
  return ['ari', 'me', 'myself', (me.name || '').toLowerCase(), (me.email || '').toLowerCase()].includes(n);
}

function recentOverrides() {
  return all('overrides', 'SELECT * FROM overrides ORDER BY id DESC LIMIT 30');
}

/** 4b: returns {bucket, owner, blocking_me, confidence, priority, priority_reason, project, follow_up_at} */
export async function classifyTask(task, hint) {
  if (!aiEnabled()) {
    return {
      bucket: 'mine', owner: 'Ari', blocking_me: false, confidence: 0,
      priority: 'P3', priority_reason: 'AI not configured', project: task.project || 'General', follow_up_at: null,
    };
  }
  const result = await callJSON({
    system: render(CLASSIFY_SYSTEM),
    user: classifyUser({ nowIst: nowIstString(), task, overrides: recentOverrides(), hint }),
    schema: CLASSIFY_SCHEMA,
    effort: 'low',
    maxTokens: 4000,
  });
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  if (!readProjects().includes(result.project)) result.project = task.project || 'General';
  return result;
}

/**
 * Classify + insert one task. `t` is the 4a/4c task shape (title, description, due_at, people,
 * project, assignee?) or a manual quick-add. Explicit fields on `t` win over the AI.
 * Returns the stored task, or the existing one if this source_ref was already ingested.
 */
export async function ingestTask(t, { source, sourceRef = null } = {}) {
  if (sourceRef) {
    const existing = one('tasks', 'SELECT * FROM tasks WHERE source = ? AND source_ref = ?', [source, sourceRef]);
    if (existing) return existing;
  }

  // Action items assigned to someone else are Not My Job with that person as owner (SPEC §4c).
  const assignedToOther = t.assignee && !isAri(t.assignee);
  const hint = assignedToOther ? `Assigned to ${t.assignee} in the source; treat as not_mine with that owner.` : undefined;

  let c;
  try {
    c = await classifyTask({ ...t, source }, hint);
  } catch (e) {
    console.error('[classify] failed, using defaults:', e.message);
    c = { bucket: 'mine', owner: 'Ari', blocking_me: false, confidence: 0, priority: 'P3', priority_reason: `Classification failed: ${e.message}`, project: t.project || 'General', follow_up_at: null };
  }

  let bucket = t.bucket || c.bucket;
  let owner = t.owner || c.owner;
  if (assignedToOther && !t.bucket) { bucket = 'not_mine'; owner = t.assignee; }
  if (bucket === 'mine') owner = 'Ari';

  const id = insert('tasks', {
    title: t.title.slice(0, 300),
    description: t.description || '',
    source,
    source_ref: sourceRef,
    project: t.project || c.project || 'General',
    bucket,
    owner,
    blocking_me: c.blocking_me,
    ai_bucket: c.bucket,
    ai_confidence: t.bucket ? 1 : c.confidence, // a bucket chosen by Ari needs no review
    priority: t.priority || c.priority,
    priority_reason: c.priority_reason,
    due_at: normaliseIso(t.due_at),
    people: t.people || [],
    status: 'open',
    follow_up_at: bucket === 'not_mine' ? normaliseIso(t.follow_up_at || c.follow_up_at) || defaultFollowUp(t.due_at) : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  return get('tasks', id);
}

export function normaliseIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

function defaultFollowUp(dueAt) {
  const base = dueAt ? new Date(new Date(dueAt).getTime() - 864e5) : new Date(Date.now() + 3 * 864e5);
  return (base < new Date() ? new Date() : base).toISOString();
}
