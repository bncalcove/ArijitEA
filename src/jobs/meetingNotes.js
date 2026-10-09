import crypto from 'node:crypto';
import { all, get, insert, update, nowIso } from '../db.js';
import { titleHint } from '../integrations/granola.js';
import { sendOnce } from '../integrations/whatsapp.js';
import { extractMeetingNotes } from '../ai/extract.js';
import { ingestTask } from '../ai/classify.js';
import { fmtDateTime } from '../time.js';

const words = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));

function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * Match notes to a calendar event on title and time. If unclear, take the closest event that
 * ended in the last 24h and flag it for confirmation (SPEC §4c).
 */
export function matchMeeting(hint, at = new Date()) {
  const t = at.getTime();
  const candidates = all('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND start_at BETWEEN ? AND ?`,
    [new Date(t - 3 * 864e5).toISOString(), new Date(t + 3600e3).toISOString()]);
  if (!candidates.length) return { meeting: null, needsConfirmation: true };

  const scored = candidates
    .map(m => ({ m, score: similarity(hint, m.title), dist: Math.abs(new Date(m.end_at || m.start_at).getTime() - t) }))
    .sort((a, b) => b.score - a.score || a.dist - b.dist);
  if (scored[0].score >= 0.5) return { meeting: scored[0].m, needsConfirmation: false };

  const recent = candidates
    .filter(m => m.end_at && new Date(m.end_at).getTime() <= t && new Date(m.end_at).getTime() >= t - 864e5)
    .sort((a, b) => new Date(b.end_at) - new Date(a.end_at));
  return { meeting: recent[0] || scored[0].m, needsConfirmation: true };
}

/** 4c: store notes on a meeting, extract summary/decisions/action items, create tasks. */
export async function processNotes({ text, source = 'paste', meetingId = null, subject = '', receivedAt = nowIso() }) {
  if (!text?.trim()) throw new Error('Notes are empty');

  let meeting = meetingId ? get('meetings', meetingId) : null;
  let needsConfirmation = false;
  if (!meeting) {
    if (meetingId) throw new Error('Meeting not found');
    const m = matchMeeting(titleHint(text, subject), new Date(receivedAt));
    meeting = m.meeting;
    needsConfirmation = m.needsConfirmation;
  }
  if (!meeting) {
    // No calendar event to attach to — keep the notes on an ad-hoc meeting row.
    const id = insert('meetings', { title: titleHint(text, subject) || 'Untitled meeting', start_at: receivedAt, end_at: receivedAt, platform: 'other' });
    meeting = get('meetings', id);
    needsConfirmation = true;
  }

  const out = await extractMeetingNotes({ meeting, notes: text });
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
  const actionItems = [];
  for (const [i, a] of out.action_items.entries()) {
    const task = await ingestTask(
      { ...a, description: `${a.description}\n\nFrom meeting: "${meeting.title}" (${fmtDateTime(meeting.start_at)})` },
      { source: 'meeting', sourceRef: `${meeting.id}:${hash}#${i}` },
    );
    actionItems.push({ ...a, task_id: task.id, bucket: task.bucket, owner: task.owner });
  }

  update('meetings', meeting.id, {
    notes_source: source, notes_received_at: receivedAt, notes_raw: text, notes_summary: out.summary,
    decisions: out.decisions, action_items: actionItems, notes_needs_confirmation: needsConfirmation,
    processed_at: nowIso(),
  });
  return get('meetings', meeting.id);
}

/** Every 30 min: meetings that ended 2h+ ago with no notes → one WhatsApp nudge each. */
export async function notesCheck() {
  const now = Date.now();
  const pending = all('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND no_notes_needed = 0 AND notes_raw IS NULL
    AND end_at BETWEEN ? AND ?`, [new Date(now - 3 * 864e5).toISOString(), new Date(now - 2 * 3600e3).toISOString()]);
  let sent = 0;
  for (const m of pending) {
    // Solo calendar blocks ("Focus time") don't produce notes.
    if (m.attendees.length < 2 && !m.join_link) continue;
    const ok = await sendOnce({ type: 'notes_nudge', dedupeKey: `notes-nudge:${m.id}`, text: `📝 Paste Granola notes for *${m.title}* (${fmtDateTime(m.start_at)})` });
    if (ok) sent++;
  }
  return { sent };
}
