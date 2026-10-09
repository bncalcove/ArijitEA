// Granola notes arrive either pasted into the dashboard or emailed with NOTES_EMAIL_TAG in
// the subject. Granola output is already structured markdown; we only normalise it and pull
// out a title/time hint to match it to a calendar event.

import { htmlToText } from './gmail.js';

export function normaliseNotes(raw) {
  let text = String(raw || '');
  if (/<\/?(p|div|br|li|h\d)\b/i.test(text)) text = htmlToText(text);
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Best-effort title hint: first markdown heading or first non-empty line. */
export function titleHint(text, subject = '') {
  const tag = process.env.NOTES_EMAIL_TAG || '[EA-NOTES]';
  const fromSubject = subject.replace(tag, '').replace(/^(re|fwd?):\s*/i, '').trim();
  if (fromSubject) return fromSubject;
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return (text.split('\n').find(l => l.trim()) || '').trim().slice(0, 120);
}

export function isNotesEmail(subject) {
  const tag = process.env.NOTES_EMAIL_TAG || '[EA-NOTES]';
  return subject.includes(tag);
}
