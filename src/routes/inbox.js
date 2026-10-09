import { Router } from 'express';
import { all, get, update } from '../db.js';

const r = Router();

r.get('/inbox', (req, res) => {
  const where = ['skipped_reason IS NULL', 'processed_at IS NOT NULL', 'received_at > ?'];
  const params = [new Date(Date.now() - 14 * 864e5).toISOString()];
  if (req.query.needs_reply === 'true') where.push(`needs_reply = 1 AND status IN ('new','seen')`);
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  else where.push(`status != 'archived'`);

  const emails = all('emails', `SELECT id, gmail_id, thread_id, from_name, from_email, subject, received_at, summary, needs_reply,
    reply_by, urgency, suggested_reply_points, task_ids, status FROM emails WHERE ${where.join(' AND ')}
    ORDER BY needs_reply DESC, received_at DESC LIMIT 100`, params);

  res.json(emails.map(e => ({
    ...e,
    gmail_link: `https://mail.google.com/mail/u/0/#all/${e.thread_id}`,
    tasks: e.task_ids.map(id => get('tasks', id)).filter(Boolean).map(t => ({ id: t.id, title: t.title, bucket: t.bucket, owner: t.owner, status: t.status })),
  })));
});

r.patch('/inbox/:id', (req, res) => {
  const email = get('emails', Number(req.params.id));
  if (!email) return res.status(404).json({ error: 'Not found' });
  const { status, needs_reply } = req.body || {};
  if (status && !['new', 'seen', 'replied', 'archived'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  update('emails', email.id, { status, needs_reply });
  res.json({ ok: true });
});

export default r;
