import { callJSON, aiEnabled } from '../integrations/anthropic.js';
import {
  EXTRACT_EMAIL_SYSTEM, EXTRACT_EMAIL_SCHEMA, extractEmailUser,
  MEETING_NOTES_SYSTEM, MEETING_NOTES_SCHEMA, meetingNotesUser,
  render, nowIstString,
} from './prompts.js';

/** 4a: email → {summary, needs_reply, reply_by, urgency, suggested_reply_points, tasks[]} */
export async function extractEmail({ fromName, fromEmail, subject, body, thread }) {
  if (!aiEnabled()) return ruleBasedEmail({ subject, body });
  const out = await callJSON({
    system: render(EXTRACT_EMAIL_SYSTEM),
    user: extractEmailUser({ nowIst: nowIstString(), fromName, fromEmail, subject, body, thread }),
    schema: EXTRACT_EMAIL_SCHEMA,
    effort: 'medium',
  });
  out.summary = trimWords(out.summary, 120);
  return out;
}

/** 4c: Granola notes + matched event → {summary, decisions[], action_items[]} */
export async function extractMeetingNotes({ meeting, notes }) {
  if (!aiEnabled()) return ruleBasedNotes(notes);
  return callJSON({
    system: render(MEETING_NOTES_SYSTEM),
    user: meetingNotesUser({ meeting, notes }),
    schema: MEETING_NOTES_SCHEMA,
    effort: 'medium',
  });
}

// ---------- rule-based fallbacks (AI_PROVIDER=off / no provider found) ----------
const ASK = /\?|\b(please|kindly|request|approve|approval|confirm|let me know|revert|need your|can you|could you|asap|urgent)\b/i;
const URGENT = /\b(urgent|asap|immediately|today|eod|legal|payment|overdue)\b/i;

function ruleBasedEmail({ subject, body }) {
  const sentences = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.length > 3);
  const summary = trimWords(sentences.slice(0, 4).join(' ') || subject, 120);
  const needsReply = ASK.test(body);
  return {
    summary,
    needs_reply: needsReply,
    reply_by: null,
    urgency: URGENT.test(`${subject} ${body}`) ? 'high' : 'normal',
    suggested_reply_points: needsReply ? sentences.filter(s => ASK.test(s)).slice(0, 3) : [],
    tasks: [],
  };
}

/** Pull "- Name to do X" / "Action: ..." lines out of Granola's markdown. */
function ruleBasedNotes(notes) {
  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean);
  const bullet = l => l.replace(/^[-*•\d.)\s[\]x]+/i, '').trim();
  const decisions = lines.filter(l => /\b(decided|agreed|decision|finali[sz]ed)\b/i.test(l)).map(bullet);
  const action_items = lines
    .filter(l => /^[-*•]|\d+[.)]/.test(l) && /\b(to|will|action|follow up|send|share|prepare|call|check)\b/i.test(l))
    .filter(l => !/\b(decided|agreed)\b/i.test(l))
    .map(l => {
      const text = bullet(l);
      const who = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:to|will)\b/);
      return { title: text.slice(0, 200), description: '', due_at: null, people: who ? [who[1]] : [], project: 'General', assignee: who ? who[1] : null };
    });
  return { summary: lines.filter(l => !/^#/.test(l)).slice(0, 5).map(bullet).join('\n'), decisions, action_items };
}

function trimWords(s, n) {
  const words = String(s || '').split(/\s+/);
  return words.length <= n ? s : words.slice(0, n).join(' ') + '…';
}
