import { all, update } from '../db.js';
import { sendOnce } from '../integrations/whatsapp.js';
import { istDateKey, istStartOfDay, istStartOfWeek, fmtTime, fmtDate, fmtDateTime } from '../time.js';

const OPEN = `status IN ('open','in_progress','waiting')`;
const people = t => (t.people?.length ? ` — ${t.people.join(', ')}` : '');
const due = t => (t.due_at ? ` (due ${fmtDateTime(t.due_at)})` : '');
const section = (title, lines) => (lines.length ? `*${title}*\n${lines.join('\n')}` : null);

function meetingsBetween(from, to) {
  return all('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND calendar_event_id IS NOT NULL AND start_at >= ? AND start_at < ? ORDER BY start_at`,
    [from.toISOString(), to.toISOString()]);
}

function meetingLine(m) {
  const rsvp = m.needs_response ? ' ⚠️ RSVP needed' : '';
  const link = m.join_link ? `\n   ${m.join_link}` : '';
  return `• ${fmtTime(m.start_at)} ${m.title}${rsvp}${link}`;
}

export function chaseLine(t) {
  const first = (t.owner || '').split(' ')[0] || 'there';
  const by = t.due_at ? ` It's due ${fmtDate(t.due_at)}.` : '';
  return `Hi ${first}, quick check on "${t.title}" — where are we on this?${by} Thanks!`;
}

/** 08:30 — today's meetings, P1/P2 My Job, overdue, emails awaiting reply, Not-My-Job to chase today. */
export async function morningBrief() {
  const today = istStartOfDay(0), tomorrow = istStartOfDay(1), now = new Date().toISOString();
  const meetings = meetingsBetween(today, tomorrow);
  const top = all('tasks', `SELECT * FROM tasks WHERE bucket = 'mine' AND ${OPEN} AND priority IN ('P1','P2')
    ORDER BY priority, COALESCE(due_at, '9999') LIMIT 10`);
  const overdue = all('tasks', `SELECT * FROM tasks WHERE ${OPEN} AND bucket = 'mine' AND due_at < ? ORDER BY due_at LIMIT 10`, [now]);
  const replies = all('emails', `SELECT * FROM emails WHERE needs_reply = 1 AND status IN ('new','seen')
    ORDER BY COALESCE(reply_by, '9999'), received_at LIMIT 10`);
  const chase = all('tasks', `SELECT * FROM tasks WHERE bucket = 'not_mine' AND ${OPEN} AND follow_up_at < ? ORDER BY owner LIMIT 15`,
    [tomorrow.toISOString()]);

  const text = [
    `☀️ *Good morning, Ari* — ${fmtDate(now)}`,
    section(`Meetings (${meetings.length})`, meetings.map(meetingLine)),
    section('Top priorities', top.map(t => `• [${t.priority}] ${t.title}${due(t)}`)),
    section(`🔴 Overdue (${overdue.length})`, overdue.map(t => `• ${t.title}${due(t)}`)),
    section(`✉️ Awaiting your reply (${replies.length})`, replies.map(e => `• ${e.from_name}: ${e.subject}${e.reply_by ? ` (by ${fmtDateTime(e.reply_by)})` : ''}`)),
    section(`Chase today (${chase.length})`, chase.map(t => `• ${t.owner}: ${t.title}`)),
  ].filter(Boolean).join('\n\n');

  return sendOnce({ type: 'morning_brief', dedupeKey: `morning:${istDateKey()}`, text });
}

/** 19:00 — "Tomorrow:" meetings + tasks due tomorrow with people involved. */
export async function tomorrowPreview() {
  const from = istStartOfDay(1), to = istStartOfDay(2);
  const meetings = meetingsBetween(from, to);
  const tasks = all('tasks', `SELECT * FROM tasks WHERE ${OPEN} AND due_at >= ? AND due_at < ? ORDER BY due_at`,
    [from.toISOString(), to.toISOString()]);
  if (!meetings.length && !tasks.length) return false;

  const text = [
    `🌙 *Tomorrow: ${fmtDate(from.toISOString())}*`,
    section('Meetings', meetings.map(meetingLine)),
    section('Due', tasks.map(t => `• ${fmtTime(t.due_at)} ${t.title}${t.bucket === 'not_mine' ? ` [${t.owner}]` : ''}${people(t)}`)),
  ].filter(Boolean).join('\n\n');

  const sent = await sendOnce({ type: 't1_preview', dedupeKey: `t1:${istDateKey()}`, text });
  if (sent) for (const t of tasks) update('tasks', t.id, { reminded_t1: true });
  return sent;
}

/** Every 5 min — tasks due in the next 30 min, not yet reminded. */
export async function dueNudge() {
  const now = new Date();
  const soon = all('tasks', `SELECT * FROM tasks WHERE ${OPEN} AND reminded_due = 0 AND due_at > ? AND due_at <= ?`,
    [now.toISOString(), new Date(now.getTime() + 30 * 60e3).toISOString()]);
  let sent = 0;
  for (const t of soon) {
    const ok = await sendOnce({
      type: 'due_nudge', taskId: t.id, dedupeKey: `due:${t.id}:${t.due_at}`,
      text: `⏰ Due at ${fmtTime(t.due_at)}: *${t.title}*${t.bucket === 'not_mine' ? ` (owner: ${t.owner})` : ''}${people(t)}`,
    });
    update('tasks', t.id, { reminded_due: true });
    if (ok) sent++;
  }
  return { sent };
}

/** 11:00 — Not My Job items with follow_up_at ≤ today, with a ready-to-send chase line per owner. */
export async function followUpChase() {
  const items = all('tasks', `SELECT * FROM tasks WHERE bucket = 'not_mine' AND ${OPEN} AND follow_up_at < ? ORDER BY owner, due_at`,
    [istStartOfDay(1).toISOString()]);
  if (!items.length) return false;

  const byOwner = new Map();
  for (const t of items) byOwner.set(t.owner || 'Unassigned', [...(byOwner.get(t.owner || 'Unassigned') || []), t]);
  const blocks = [...byOwner].map(([owner, ts]) =>
    `*${owner}*\n${ts.map(t => `• ${t.title}${t.blocking_me ? ' 🚧 blocking you' : ''}${due(t)}\n  ↳ _${chaseLine(t)}_`).join('\n')}`);

  return sendOnce({ type: 'follow_up_chase', dedupeKey: `chase:${istDateKey()}`, text: `📣 *Chase today (${items.length})*\n\n${blocks.join('\n\n')}` });
}

/** Fri 18:00 — done this week, slipped, next week's P1s. */
export async function weeklyWrap() {
  const weekStart = istStartOfWeek(), now = new Date();
  const nextWeekStart = new Date(weekStart.getTime() + 7 * 864e5), nextWeekEnd = new Date(weekStart.getTime() + 14 * 864e5);
  const done = all('tasks', `SELECT * FROM tasks WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at`, [weekStart.toISOString()]);
  const slipped = all('tasks', `SELECT * FROM tasks WHERE ${OPEN} AND due_at >= ? AND due_at < ? ORDER BY due_at`,
    [weekStart.toISOString(), now.toISOString()]);
  const nextP1 = all('tasks', `SELECT * FROM tasks WHERE ${OPEN} AND priority = 'P1'
    AND (due_at IS NULL OR (due_at >= ? AND due_at < ?)) ORDER BY due_at`, [nextWeekStart.toISOString(), nextWeekEnd.toISOString()]);

  const text = [
    `📊 *Weekly wrap — week of ${fmtDate(weekStart.toISOString())}*`,
    section(`✅ Done (${done.length})`, done.slice(0, 15).map(t => `• ${t.title}`)),
    section(`⚠️ Slipped (${slipped.length})`, slipped.map(t => `• ${t.title}${due(t)}${t.bucket === 'not_mine' ? ` [${t.owner}]` : ''}`)),
    section(`🎯 Next week's P1s (${nextP1.length})`, nextP1.map(t => `• ${t.title}${due(t)}`)),
  ].filter(Boolean).join('\n\n');

  return sendOnce({ type: 'weekly_wrap', dedupeKey: `weekly:${istDateKey()}`, text });
}
