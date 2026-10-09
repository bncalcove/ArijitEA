import { google } from 'googleapis';
import { googleAuth } from './google.js';

const gmail = () => google.gmail({ version: 'v1', auth: googleAuth() });

export async function listInboxIds({ query = 'in:inbox newer_than:2d', max = 50 } = {}) {
  const res = await gmail().users.messages.list({ userId: 'me', q: query, maxResults: max });
  return (res.data.messages || []).map(m => m.id);
}

export async function getMessage(id) {
  const res = await gmail().users.messages.get({ userId: 'me', id, format: 'full' });
  return parseMessage(res.data);
}

export async function getThread(threadId) {
  const res = await gmail().users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  return (res.data.messages || []).map(parseMessage);
}

let myEmail;
export async function getMyEmail() {
  if (!myEmail) {
    const res = await gmail().users.getProfile({ userId: 'me' });
    myEmail = res.data.emailAddress.toLowerCase();
  }
  return myEmail;
}

function header(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseFrom(v) {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() };
  return { name: v.trim(), email: v.trim().toLowerCase() };
}

function decode(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const p of part.parts || []) {
    const r = findPart(p, mime);
    if (r) return r;
  }
  return null;
}

export function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseMessage(m) {
  const headers = m.payload?.headers || [];
  const from = parseFrom(header(headers, 'From'));
  const plain = findPart(m.payload, 'text/plain');
  const html = plain ? null : findPart(m.payload, 'text/html');
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    fromName: from.name,
    fromEmail: from.email,
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    listUnsubscribe: !!header(headers, 'List-Unsubscribe'),
    receivedAt: new Date(Number(m.internalDate)).toISOString(),
    body: plain || (html ? htmlToText(html) : m.snippet || ''),
  };
}

/** Remove quoted history and signatures so the model sees only the new content. */
export function stripBody(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^From: .+/.test(line) && out.length > 3) break; // Outlook-style quoted header
    if (/^(--|__)\s*$/.test(line)) break; // signature delimiter
    if (/^Sent from my (iPhone|Android|mobile)/i.test(line)) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
}
