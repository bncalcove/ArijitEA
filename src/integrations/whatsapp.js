// WhatsApp sender. Two modes, picked from WHATSAPP_ENDPOINT:
//
// 1. Meta WhatsApp Cloud API: endpoint https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages,
//    WHATSAPP_AUTH_TOKEN = a permanent System User access token.
//    Meta only delivers free-form text within 24h of Ari's last message to the business number.
//    Outside that window it falls back to WHATSAPP_TEMPLATE, an approved template with a single
//    body variable {{1}} (language from WHATSAPP_TEMPLATE_LANG, default "en").
//
// 2. Generic relay (Twilio Function, Interakt, Gupshup, your own service), which receives:
//      POST { "to": WHATSAPP_TO_NUMBER, "text": "<message>" }   Authorization: Bearer WHATSAPP_AUTH_TOKEN

import { alreadySent, logSend } from '../db.js';

const MAX_LEN = 3800; // WhatsApp text limit is 4096; leave headroom
const isMeta = endpoint => /graph\.facebook\.com/.test(endpoint);

/** Digits only; a bare 10-digit Indian mobile gets the 91 country code. */
export function normaliseNumber(n) {
  const digits = String(n || '').replace(/\D/g, '');
  return digits.length === 10 ? '91' + digits : digits;
}

async function post(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.WHATSAPP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.WHATSAPP_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function sendMeta(endpoint, to, text) {
  const r = await post(endpoint, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } });
  if (r.ok) return { ok: true, mode: 'text' };

  // 131047 = outside the 24h customer-service window → needs an approved template.
  const code = r.data?.error?.code;
  const template = process.env.WHATSAPP_TEMPLATE;
  if (code === 131047 && template) {
    // Template variables can't contain newlines, tabs or 4+ consecutive spaces.
    const flat = text.replace(/[*_]/g, '').replace(/\s*\n+\s*/g, ' | ').replace(/\s{4,}/g, ' ').slice(0, 1000);
    const t = await post(endpoint, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: template,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: flat }] }],
      },
    });
    if (t.ok) return { ok: true, mode: 'template' };
    throw new Error(`WhatsApp template send failed: ${t.status} ${t.data?.error?.message || ''}`);
  }
  const hint = code === 131047
    ? ' — send any message to the business number from your WhatsApp (opens a 24h window), or set an approved WHATSAPP_TEMPLATE'
    : '';
  throw new Error(`WhatsApp send failed: ${r.status} ${r.data?.error?.message || JSON.stringify(r.data).slice(0, 200)}${hint}`);
}

export async function sendWhatsApp(text) {
  const endpoint = process.env.WHATSAPP_ENDPOINT;
  const body = text.length > MAX_LEN ? text.slice(0, MAX_LEN - 20) + '\n…(see dashboard)' : text;
  if (!endpoint) {
    console.log('[whatsapp:dry-run]\n' + body);
    return { dryRun: true };
  }
  const to = normaliseNumber(process.env.WHATSAPP_TO_NUMBER);
  if (!to) throw new Error('Set the WhatsApp "to" number in Settings → Connections');
  if (isMeta(endpoint)) return sendMeta(endpoint, to, body);

  const r = await post(endpoint, { to, text: body });
  if (!r.ok) throw new Error(`WhatsApp send failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return { ok: true, mode: 'relay' };
}

/** Send once per dedupeKey; every send is written to reminders_log (SPEC §5). */
export async function sendOnce({ type, dedupeKey, text, taskId = null }) {
  if (alreadySent(dedupeKey)) return false;
  await sendWhatsApp(text);
  logSend({ type, taskId, dedupeKey, payload: text });
  return true;
}
