// All prompt templates in one place (SPEC §1). Keep PROMPTS.md in sync.
// System prompts are stable text (cached); anything that changes per call — today's date,
// the email, the overrides — goes in the user message.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readRoles, readProjects } from '../db.js';

const nullableString = { type: ['string', 'null'] };
const taskShape = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'due_at', 'people', 'project', 'assignee'],
  properties: {
    title: { type: 'string', description: 'Short imperative, max ~12 words' },
    description: { type: 'string' },
    due_at: { ...nullableString, description: 'ISO 8601 with +05:30 offset, or null' },
    people: { type: 'array', items: { type: 'string' } },
    project: { type: 'string' },
    assignee: { ...nullableString, description: 'Who is expected to do it, if stated; "Ari" if Ari' },
  },
};

// ---------- 4a. Email → summary + tasks ----------
export const EXTRACT_EMAIL_SYSTEM = `You are the executive assistant for Ari at Alcove Realty, a real-estate developer in India.
You read one incoming email (plus a little thread context) and produce a JSON digest.

Rules:
- summary: at most 120 words, about a one-minute read. Cover who is writing, what they want from Ari, by when, and what is at stake. Plain language; no greetings or filler.
- needs_reply: true only if the sender is waiting for Ari to answer, decide, approve or send something. FYIs, CCs and confirmations are false.
- reply_by: an ISO 8601 timestamp with +05:30 offset if a deadline is stated or clearly implied; otherwise null.
- suggested_reply_points: 0–4 short bullet points Ari could cover in a reply. Empty if needs_reply is false.
- urgency: "high" if money, legal, a senior person or a same-day deadline is involved; "low" for FYI; else "normal".
- tasks: concrete actions that arise from this email for Ari or someone on Ari's team. Do not create a task just to "reply to this email" — needs_reply already covers that — unless the reply requires real work (prepare a document, check figures, arrange a visit). Do not invent tasks. Resolve relative dates ("by Friday", "EOD") against the current IST date given in the message.
- project: choose the best match from the project list; use "General" if none fits.
- people: names of people involved in each task (not Ari).

Projects: {{PROJECTS}}`;

export const EXTRACT_EMAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'needs_reply', 'reply_by', 'urgency', 'suggested_reply_points', 'tasks'],
  properties: {
    summary: { type: 'string' },
    needs_reply: { type: 'boolean' },
    reply_by: nullableString,
    urgency: { type: 'string', enum: ['high', 'normal', 'low'] },
    suggested_reply_points: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: taskShape },
  },
};

export function extractEmailUser({ nowIst, fromName, fromEmail, subject, body, thread }) {
  return `Current date/time (IST): ${nowIst}

<thread_context>
${thread || '(none)'}
</thread_context>

<email>
From: ${fromName} <${fromEmail}>
Subject: ${subject}

${body}
</email>`;
}

// ---------- 4c. Meeting notes → summary + decisions + action items ----------
export const MEETING_NOTES_SYSTEM = `You are the executive assistant for Ari at Alcove Realty.
You receive Granola meeting notes (already structured) plus the matched calendar event. Your main job is to pull out action items and their owners accurately.

Rules:
- summary: exactly 5 short lines separated by newlines covering purpose, key discussion, outcome, open questions, next step.
- decisions: each decision actually agreed in the meeting, one sentence each.
- action_items: every follow-up action. Set assignee to the person responsible exactly as named in the notes ("Ari" if it is Ari). If nobody is named, set assignee to null.
- Resolve relative dates against the meeting date. Use ISO 8601 with +05:30 offset, or null.
- project: best match from the project list, else "General".
- Do not invent actions or decisions that are not in the notes.

Projects: {{PROJECTS}}`;

export const MEETING_NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'decisions', 'action_items'],
  properties: {
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    action_items: { type: 'array', items: taskShape },
  },
};

export function meetingNotesUser({ meeting, notes }) {
  const attendees = (meeting?.attendees || []).map(a => `${a.name} <${a.email}>`).join(', ');
  return `<calendar_event>
Title: ${meeting?.title ?? '(unmatched)'}
Start (IST): ${meeting?.start_at ? toIst(meeting.start_at) : 'unknown'}
Attendees: ${attendees || 'unknown'}
</calendar_event>

<granola_notes>
${notes}
</granola_notes>`;
}

// ---------- 4b. Task → bucket + owner + priority ----------
export const CLASSIFY_SYSTEM = `You are the executive assistant for Ari at Alcove Realty. You triage one task at a time.

Decide:
- bucket: "mine" if Ari personally has to do, decide or deliver it; "not_mine" if someone else owns it and Ari only needs to track it.
- owner: for "not_mine", the responsible person's name, preferably someone from the people list. For "mine", "Ari".
- blocking_me: true if Ari is waiting on this to finish Ari's own work.
- confidence: 0.0–1.0, how sure you are about the bucket and owner. Use below 0.6 when the rules do not clearly apply.
- priority: P1–P4 per the role rules; priority_reason is one short sentence.
- project: best match from the project list.
- follow_up_at: for "not_mine", when Ari should chase the owner (ISO 8601 with +05:30, per the role rules); for "mine", null.

Follow Ari's role rules below. The "Recent corrections" in the message are Ari's own fixes to earlier calls; treat them as the strongest signal for similar tasks.

<role_rules>
{{ROLE_RULES}}
</role_rules>

<ari>
{{ME}}
</ari>

<people>
{{PEOPLE}}
</people>

Projects: {{PROJECTS}}`;

export const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bucket', 'owner', 'blocking_me', 'confidence', 'priority', 'priority_reason', 'project', 'follow_up_at'],
  properties: {
    bucket: { type: 'string', enum: ['mine', 'not_mine'] },
    owner: { type: 'string' },
    blocking_me: { type: 'boolean' },
    confidence: { type: 'number' },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
    priority_reason: { type: 'string' },
    project: { type: 'string' },
    follow_up_at: nullableString,
  },
};

export function classifyUser({ nowIst, task, overrides, hint }) {
  const corrections = overrides.length
    ? overrides.map(o => `- "${o.task_title}": ${o.from_bucket}/${o.from_owner || '-'} → ${o.to_bucket}/${o.to_owner || '-'}${o.note ? ` (${o.note})` : ''}`).join('\n')
    : '(none yet)';
  return `Current date/time (IST): ${nowIst}

Recent corrections by Ari (newest first):
${corrections}

<task>
Title: ${task.title}
Description: ${task.description || ''}
Due: ${task.due_at ? toIst(task.due_at) : 'none'}
People: ${(task.people || []).join(', ') || 'none'}
Project (suggested): ${task.project || 'none'}
Source: ${task.source}
${hint ? `Hint: ${hint}` : ''}
</task>`;
}

// ---------- shared ----------
export function toIst(iso) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

export function nowIstString() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
}

export function readRoleRules() {
  const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const m = md.match(/## Role rules\s*\n([\s\S]*?)(\n## |\s*$)/);
  return (m ? m[1] : md).replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** Fill {{PLACEHOLDERS}} from config files. Output is stable between config edits, so it caches. */
export function render(template) {
  const roles = readRoles();
  const people = (roles.people || []).map(p => `- ${p.name} <${p.email || ''}> | ${p.team || ''} | ${p.role || ''} | owns: ${p.owns || ''}`).join('\n');
  return template
    .replace('{{ROLE_RULES}}', readRoleRules())
    .replace('{{ME}}', `${roles.me?.name} — ${roles.me?.role}. Owns: ${roles.me?.owns}`)
    .replace('{{PEOPLE}}', people || '(none configured)')
    .replace(/\{\{PROJECTS\}\}/g, readProjects().join(', '));
}
