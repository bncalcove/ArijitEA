// Generic WhatsApp sender. WHATSAPP_ENDPOINT receives:
//   POST { "to": WHATSAPP_TO_NUMBER, "text": "<message>" }
//   Authorization: Bearer WHATSAPP_AUTH_TOKEN
// Point it at your provider (Meta Cloud API relay, Twilio function, Interakt, Gupshup, etc.).
// If your provider needs a different body, change buildBody() only.

import { alreadySent, logSend } from '../db.js';

const MAX_LEN = 3800; // WhatsApp text limit is 4096; leave headroom

function buildBody(text) {
  return { to: process.env.WHATSAPP_TO_NUMBER, text };
}

export async function sendWhatsApp(text) {
  const endpoint = process.env.WHATSAPP_ENDPOINT;
  const body = text.length > MAX_LEN ? text.slice(0, MAX_LEN - 20) + '\n…(see dashboard)' : text;
  if (!endpoint) {
    console.log('[whatsapp:dry-run]\n' + body);
    return { dryRun: true };
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.WHATSAPP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.WHATSAPP_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(buildBody(body)),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${await res.text()}`);
  return { ok: true };
}

/** Send once per dedupeKey; every send is written to reminders_log (SPEC §5). */
export async function sendOnce({ type, dedupeKey, text, taskId = null }) {
  if (alreadySent(dedupeKey)) return false;
  await sendWhatsApp(text);
  logSend({ type, taskId, dedupeKey, payload: text });
  return true;
}
