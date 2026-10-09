import { db, insert, update, all, getSettings, markSync, nowIso, readRoles } from '../db.js';
import { googleEnabled } from '../integrations/google.js';
import { listInboxIds, getMessage, getThread, getMyEmail, stripBody } from '../integrations/gmail.js';
import { isNotesEmail, normaliseNotes } from '../integrations/granola.js';
import { extractEmail } from '../ai/extract.js';
import { ingestTask, normaliseIso } from '../ai/classify.js';
import { processNotes } from './meetingNotes.js';

const SKIP_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM'];

function skipReason(msg, settings) {
  const cat = msg.labelIds.find(l => SKIP_CATEGORIES.includes(l));
  if (cat) return cat.replace('CATEGORY_', '').toLowerCase();
  const from = `${msg.fromName} ${msg.fromEmail}`.toLowerCase();
  const hit = (settings.sender_blocklist || []).find(b => b && from.includes(String(b).toLowerCase()));
  if (hit) return `blocklist:${hit}`;
  // Bulk mail from outside the company that slipped past Gmail's categories.
  const domains = readRoles().company_domains || [];
  if (msg.listUnsubscribe && !domains.some(d => msg.fromEmail.endsWith('@' + d))) return 'bulk';
  return null;
}

export async function syncGmail() {
  if (!googleEnabled()) return { skipped: 'Google not configured' };
  try {
    const settings = getSettings();
    const me = await getMyEmail();
    const ids = await listInboxIds();
    const known = new Set(
      ids.length
        ? db.prepare(`SELECT gmail_id FROM emails WHERE gmail_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.gmail_id)
        : [],
    );
    let processed = 0;

    for (const id of ids.filter(i => !known.has(i)).reverse()) { // oldest first
      const msg = await getMessage(id);
      const base = {
        gmail_id: msg.id, thread_id: msg.threadId, from_name: msg.fromName, from_email: msg.fromEmail,
        subject: msg.subject, received_at: msg.receivedAt,
      };

      if (msg.fromEmail === me && !isNotesEmail(msg.subject)) {
        insert('emails', { ...base, status: 'archived', skipped_reason: 'from_me', processed_at: nowIso() });
        continue;
      }

      if (isNotesEmail(msg.subject)) {
        insert('emails', { ...base, status: 'archived', skipped_reason: 'meeting_notes', processed_at: nowIso() });
        await processNotes({ text: normaliseNotes(msg.body), source: 'email', subject: msg.subject, receivedAt: msg.receivedAt })
          .catch(e => console.error('[syncGmail] notes email failed:', e.message));
        continue;
      }

      const reason = skipReason(msg, settings);
      if (reason) {
        insert('emails', { ...base, status: 'archived', skipped_reason: reason, processed_at: nowIso() });
        continue;
      }

      const body = stripBody(msg.body);
      const emailId = insert('emails', { ...base, body, status: 'new' });
      try {
        const thread = await threadContext(msg);
        const out = await extractEmail({ fromName: msg.fromName, fromEmail: msg.fromEmail, subject: msg.subject, body, thread });
        const taskIds = [];
        for (const [i, t] of out.tasks.entries()) {
          const task = await ingestTask(
            { ...t, people: t.people?.length ? t.people : [msg.fromName], description: `${t.description}\n\nFrom email: "${msg.subject}" (${msg.fromName})` },
            { source: 'email', sourceRef: `${msg.id}#${i}` },
          );
          taskIds.push(task.id);
        }
        update('emails', emailId, {
          summary: out.summary, needs_reply: out.needs_reply, reply_by: normaliseIso(out.reply_by),
          urgency: out.urgency, suggested_reply_points: out.suggested_reply_points, task_ids: taskIds,
          processed_at: nowIso(),
        });
        processed++;
      } catch (e) {
        console.error(`[syncGmail] extract failed for ${msg.id}:`, e.message);
        update('emails', emailId, { skipped_reason: `error: ${e.message}`.slice(0, 300), processed_at: nowIso() });
      }
    }

    await checkReplies(me);
    markSync('gmail');
    return { processed };
  } catch (e) {
    markSync('gmail', e.message);
    throw e;
  }
}

async function threadContext(msg) {
  try {
    const thread = await getThread(msg.threadId);
    return thread
      .filter(m => m.id !== msg.id && m.receivedAt < msg.receivedAt)
      .slice(-3)
      .map(m => `[${m.receivedAt}] ${m.fromName}: ${stripBody(m.body).slice(0, 800)}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

/** Mark emails as replied when Ari has sent a later message in the same thread. */
async function checkReplies(me) {
  const open = all('emails', `SELECT * FROM emails WHERE needs_reply = 1 AND status IN ('new','seen')
    AND received_at > ? ORDER BY received_at DESC LIMIT 25`, [new Date(Date.now() - 14 * 864e5).toISOString()]);
  for (const e of open) {
    try {
      const thread = await getThread(e.thread_id);
      if (thread.some(m => m.fromEmail === me && m.receivedAt > e.received_at)) update('emails', e.id, { status: 'replied' });
    } catch { /* thread may be deleted */ }
  }
}
