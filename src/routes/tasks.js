import { Router } from 'express';
import { all, one, get, update, insert, getSyncStatus, readProjects } from '../db.js';
import { ingestTask, normaliseIso, REVIEW_THRESHOLD } from '../ai/classify.js';
import { chaseLine } from '../jobs/reminders.js';
import { istStartOfDay, fmtDateTime } from '../time.js';

const r = Router();
const OPEN = `status IN ('open','in_progress','waiting')`;
const decorate = t => t && ({ ...t, needs_review: t.ai_confidence != null && t.ai_confidence < REVIEW_THRESHOLD && !t.overridden, chase_message: t.bucket === 'not_mine' ? chaseLine(t) : null });

// Today strip
r.get('/today', (req, res) => {
  const now = new Date().toISOString(), tomorrow = istStartOfDay(1).toISOString();
  const next = one('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND calendar_event_id IS NOT NULL AND end_at > ? ORDER BY start_at LIMIT 1`, [now]);
  const count = (sql, p = []) => one('x', sql, p).n;
  res.json({
    next_meeting: next,
    p1_count: count(`SELECT COUNT(*) n FROM tasks WHERE bucket = 'mine' AND ${OPEN} AND priority = 'P1'`),
    overdue_count: count(`SELECT COUNT(*) n FROM tasks WHERE bucket = 'mine' AND ${OPEN} AND due_at < ?`, [now]),
    awaiting_reply_count: count(`SELECT COUNT(*) n FROM emails WHERE needs_reply = 1 AND status IN ('new','seen')`),
    chase_today_count: count(`SELECT COUNT(*) n FROM tasks WHERE bucket = 'not_mine' AND ${OPEN} AND follow_up_at < ?`, [tomorrow]),
    review_count: count(`SELECT COUNT(*) n FROM tasks WHERE ${OPEN} AND overridden = 0 AND ai_confidence < ?`, [REVIEW_THRESHOLD]),
    sync: getSyncStatus(),
    projects: readProjects(),
  });
});

r.get('/tasks', (req, res) => {
  const { bucket, status, project, priority, q } = req.query;
  const where = [], params = [];
  if (bucket) { where.push('bucket = ?'); params.push(bucket); }
  if (status === 'all') { /* no filter */ }
  else if (status) { where.push('status = ?'); params.push(status); }
  else where.push(OPEN);
  if (project) { where.push('project = ?'); params.push(project); }
  if (priority) { where.push('priority = ?'); params.push(priority); }
  if (q) { where.push('(title LIKE ? OR description LIKE ? OR owner LIKE ? OR people LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'done' THEN 1 WHEN 'dropped' THEN 2 ELSE 0 END, priority, COALESCE(due_at, '9999'), id DESC LIMIT 500`;
  res.json(all('tasks', sql, params).map(decorate));
});

// Quick add — AI fills whatever is missing.
r.post('/tasks', async (req, res, next) => {
  try {
    const { title, due_at, people = [], project, notes, bucket, owner } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    if (bucket && !['mine', 'not_mine'].includes(bucket)) return res.status(400).json({ error: 'Bad bucket' });
    const task = await ingestTask(
      { title: title.trim(), description: notes || '', due_at: normaliseIso(due_at), people, project: project || undefined, bucket: bucket || undefined, owner: owner || undefined },
      { source: 'manual' },
    );
    let message = 'Task added.';
    if (task.due_at) {
      const dayBefore7pm = new Date(istStartOfDay(-1, new Date(task.due_at)).getTime() + 19 * 3600e3);
      message = `Reminder set for ${fmtDateTime(task.due_at)} + day-before at 7 pm${dayBefore7pm < new Date() ? ' (day-before already passed)' : ''}.`;
    }
    res.status(201).json({ task: decorate(task), message });
  } catch (e) { next(e); }
});

const EDITABLE = ['title', 'description', 'project', 'priority', 'due_at', 'people', 'status', 'follow_up_at', 'owner', 'bucket', 'blocking_me'];

r.patch('/tasks/:id', (req, res) => {
  const task = get('tasks', Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const patch = {};
  for (const k of EDITABLE) if (k in body) patch[k] = body[k];

  if (body.snooze_days) {
    const base = task.due_at && new Date(task.due_at) > new Date() ? new Date(task.due_at) : new Date();
    patch.due_at = new Date(base.getTime() + Number(body.snooze_days) * 864e5).toISOString();
  }
  for (const k of ['due_at', 'follow_up_at']) if (k in patch) patch[k] = normaliseIso(patch[k]);
  if ('due_at' in patch && patch.due_at !== task.due_at) { patch.reminded_t1 = false; patch.reminded_due = false; }

  if (patch.status && patch.status !== task.status) patch.completed_at = patch.status === 'done' ? new Date().toISOString() : null;

  // Bucket/owner override → learnable correction (SPEC §3 overrides).
  const toBucket = patch.bucket ?? task.bucket;
  if (toBucket === 'mine') patch.owner = 'Ari';
  if (toBucket === 'not_mine' && task.bucket === 'mine' && !patch.owner) patch.owner = body.owner || 'Unassigned';
  if (toBucket === 'not_mine' && !task.follow_up_at && !patch.follow_up_at) patch.follow_up_at = new Date(Date.now() + 864e5).toISOString();
  const toOwner = patch.owner ?? task.owner;
  if (toBucket !== task.bucket || toOwner !== task.owner) {
    patch.overridden = true;
    insert('overrides', {
      task_id: task.id, from_bucket: task.bucket, to_bucket: toBucket, from_owner: task.owner, to_owner: toOwner,
      task_title: task.title, note: body.override_note || null,
    });
  }
  if (body.confirm_ai) patch.overridden = true; // "looks right" clears the Review badge

  update('tasks', task.id, patch);
  res.json(decorate(get('tasks', task.id)));
});

r.get('/people', (req, res) => res.json(all('people', 'SELECT * FROM people ORDER BY name')));

export default r;
