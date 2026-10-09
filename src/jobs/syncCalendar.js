import { one, insert, update, getSettings, markSync, readRoles, nowIso } from '../db.js';
import { googleEnabled } from '../integrations/google.js';
import { listEvents } from '../integrations/calendar.js';

function isKeyMeeting(ev, settings) {
  if (ev.cancelled) return false;
  const domains = readRoles().company_domains || [];
  const external = ev.attendees.some(a => a.email && !a.self && !domains.some(d => a.email.endsWith('@' + d)));
  const title = ev.title.toLowerCase();
  const keyword = (settings.key_meeting_keywords || []).some(k => k && title.includes(String(k).toLowerCase()));
  return external || keyword;
}

export async function syncCalendar() {
  if (!googleEnabled()) return { skipped: 'Google not configured' };
  try {
    const settings = getSettings();
    const events = await listEvents({ days: 14 });
    let prepTasks = 0;

    for (const ev of events) {
      const isKey = isKeyMeeting(ev, settings);
      const fields = {
        title: ev.title, start_at: ev.startAt, end_at: ev.endAt, platform: ev.platform, join_link: ev.joinLink,
        organizer: ev.organizer, attendees: ev.attendees, rsvp_status: ev.rsvpStatus,
        needs_response: ev.rsvpStatus === 'needsAction' && !ev.cancelled, is_key: isKey, cancelled: ev.cancelled,
      };
      const existing = one('meetings', 'SELECT * FROM meetings WHERE calendar_event_id = ?', [ev.id]);
      if (existing) update('meetings', existing.id, fields);
      else insert('meetings', { calendar_event_id: ev.id, ...fields });

      // Prep task one day before key meetings (SPEC §5).
      if (isKey && new Date(ev.startAt) > new Date()) {
        const ref = `${ev.id}:prep`;
        if (!one('tasks', 'SELECT id FROM tasks WHERE source = ? AND source_ref = ?', ['calendar', ref])) {
          const due = new Date(new Date(ev.startAt).getTime() - 864e5);
          insert('tasks', {
            title: `Prep: ${ev.title}`,
            description: `Prepare for "${ev.title}". Attendees: ${ev.attendees.map(a => a.name).join(', ')}`,
            source: 'calendar', source_ref: ref, project: 'General', bucket: 'mine', owner: 'Ari',
            ai_bucket: 'mine', ai_confidence: 1, priority: 'P2', priority_reason: 'Key meeting tomorrow',
            due_at: (due < new Date() ? new Date() : due).toISOString(),
            people: ev.attendees.filter(a => !a.self).map(a => a.name).slice(0, 8),
            status: 'open', created_at: nowIso(), updated_at: nowIso(),
          });
          prepTasks++;
        }
      }
    }
    markSync('calendar');
    return { events: events.length, prepTasks };
  } catch (e) {
    markSync('calendar', e.message);
    throw e;
  }
}
