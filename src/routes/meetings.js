import { Router } from 'express';
import { all, get, update } from '../db.js';
import { processNotes } from '../jobs/meetingNotes.js';
import { normaliseNotes } from '../integrations/granola.js';
import { istStartOfDay } from '../time.js';

const r = Router();

// range = upcoming (today + 7 days, default) | past (last 30 days)
r.get('/meetings', (req, res) => {
  const now = new Date().toISOString();
  if (req.query.range === 'past') {
    const from = new Date(Date.now() - 30 * 864e5).toISOString();
    return res.json(all('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND start_at >= ? AND start_at <= ?
      ORDER BY start_at DESC`, [from, now]).map(m => ({
      ...m,
      notes_pending: !m.notes_raw && !m.no_notes_needed && m.end_at && m.end_at < now,
    })));
  }
  const from = istStartOfDay(0).toISOString(), to = istStartOfDay(8).toISOString();
  res.json(all('meetings', `SELECT * FROM meetings WHERE cancelled = 0 AND calendar_event_id IS NOT NULL AND start_at >= ? AND start_at < ? ORDER BY start_at`, [from, to]));
});

async function handleNotes(req, res, next, meetingId) {
  try {
    const text = normaliseNotes(req.body?.notes);
    if (!text) return res.status(400).json({ error: 'Paste the notes first' });
    const meeting = await processNotes({ text, source: 'paste', meetingId });
    res.json(meeting);
  } catch (e) {
    if (/not found|empty/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
}

// Without an id the notes are matched to the closest event.
r.post('/meetings/notes', (req, res, next) => handleNotes(req, res, next, null));
r.post('/meetings/:id/notes', (req, res, next) => handleNotes(req, res, next, Number(req.params.id)));

r.patch('/meetings/:id', (req, res) => {
  const m = get('meetings', Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { no_notes_needed, prep_note, confirm_match } = req.body || {};
  update('meetings', m.id, {
    no_notes_needed,
    prep_note,
    notes_needs_confirmation: confirm_match ? false : undefined,
  });
  res.json(get('meetings', m.id));
});

export default r;
