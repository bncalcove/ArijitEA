import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR env, else /data if the host mounted a persistent volume there, else ./data.
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data';
  } catch { return path.join(ROOT, 'data'); }
}
export const DATA_DIR = pickDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'ea.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---- schema + migrations (PRAGMA user_version) ----
const MIGRATIONS = [
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    source TEXT NOT NULL CHECK (source IN ('email','calendar','meeting','manual','whatsapp')),
    source_ref TEXT,
    project TEXT,
    bucket TEXT NOT NULL DEFAULT 'mine' CHECK (bucket IN ('mine','not_mine')),
    owner TEXT,
    blocking_me INTEGER NOT NULL DEFAULT 0,
    ai_bucket TEXT,
    ai_confidence REAL,
    overridden INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
    priority_reason TEXT,
    due_at TEXT,
    people TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','done','dropped')),
    follow_up_at TEXT,
    reminded_t1 INTEGER NOT NULL DEFAULT 0,
    reminded_due INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT
  );
  CREATE INDEX idx_tasks_bucket_status ON tasks(bucket, status);
  CREATE INDEX idx_tasks_due ON tasks(due_at);
  CREATE UNIQUE INDEX idx_tasks_source_ref ON tasks(source, source_ref) WHERE source_ref IS NOT NULL;

  CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_id TEXT NOT NULL UNIQUE,
    thread_id TEXT,
    from_name TEXT,
    from_email TEXT,
    subject TEXT,
    received_at TEXT,
    body TEXT,                         -- purged after 30 days (SPEC §8)
    summary TEXT,
    needs_reply INTEGER NOT NULL DEFAULT 0,
    reply_by TEXT,
    urgency TEXT,
    suggested_reply_points TEXT NOT NULL DEFAULT '[]',
    task_ids TEXT NOT NULL DEFAULT '[]',
    skipped_reason TEXT,
    processed_at TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','replied','archived'))
  );
  CREATE INDEX idx_emails_received ON emails(received_at);

  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_event_id TEXT UNIQUE,
    title TEXT,
    start_at TEXT,
    end_at TEXT,
    platform TEXT CHECK (platform IN ('meet','zoom','teams','other')),
    join_link TEXT,
    organizer TEXT,
    attendees TEXT NOT NULL DEFAULT '[]',
    rsvp_status TEXT,
    needs_response INTEGER NOT NULL DEFAULT 0,
    prep_note TEXT,
    is_key INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    notes_source TEXT CHECK (notes_source IN ('paste','email')),
    notes_received_at TEXT,
    notes_raw TEXT,
    notes_summary TEXT,
    notes_needs_confirmation INTEGER NOT NULL DEFAULT 0,
    no_notes_needed INTEGER NOT NULL DEFAULT 0,
    decisions TEXT NOT NULL DEFAULT '[]',
    action_items TEXT NOT NULL DEFAULT '[]',
    processed_at TEXT
  );
  CREATE INDEX idx_meetings_start ON meetings(start_at);

  CREATE TABLE overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    from_bucket TEXT, to_bucket TEXT,
    from_owner TEXT, to_owner TEXT,
    task_title TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    team TEXT,
    role TEXT,
    owns TEXT
  );

  CREATE TABLE reminders_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    task_id INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    payload TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sync_status (
    source TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_ok_at TEXT,
    last_error TEXT
  );
  `,
  `
  -- Keys entered on the dashboard (Settings → Connections) and app-generated secrets.
  -- Kept apart from settings so GET /api/settings can never return them.
  CREATE TABLE secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Allow notes pushed by the Granola webhook (notes_source = 'webhook').
  CREATE TABLE meetings_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_event_id TEXT UNIQUE,
    title TEXT,
    start_at TEXT,
    end_at TEXT,
    platform TEXT CHECK (platform IN ('meet','zoom','teams','other')),
    join_link TEXT,
    organizer TEXT,
    attendees TEXT NOT NULL DEFAULT '[]',
    rsvp_status TEXT,
    needs_response INTEGER NOT NULL DEFAULT 0,
    prep_note TEXT,
    is_key INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    notes_source TEXT CHECK (notes_source IN ('paste','email','webhook')),
    notes_received_at TEXT,
    notes_raw TEXT,
    notes_summary TEXT,
    notes_needs_confirmation INTEGER NOT NULL DEFAULT 0,
    no_notes_needed INTEGER NOT NULL DEFAULT 0,
    decisions TEXT NOT NULL DEFAULT '[]',
    action_items TEXT NOT NULL DEFAULT '[]',
    processed_at TEXT
  );
  INSERT INTO meetings_v3 (id, calendar_event_id, title, start_at, end_at, platform, join_link, organizer, attendees, rsvp_status, needs_response, prep_note, is_key, cancelled, notes_source, notes_received_at, notes_raw, notes_summary, notes_needs_confirmation, no_notes_needed, decisions, action_items, processed_at) SELECT id, calendar_event_id, title, start_at, end_at, platform, join_link, organizer, attendees, rsvp_status, needs_response, prep_note, is_key, cancelled, notes_source, notes_received_at, notes_raw, notes_summary, notes_needs_confirmation, no_notes_needed, decisions, action_items, processed_at FROM meetings;
  DROP TABLE meetings;
  ALTER TABLE meetings_v3 RENAME TO meetings;
  CREATE INDEX idx_meetings_start ON meetings(start_at);
  `,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrate();

// ---- helpers ----
export const nowIso = () => new Date().toISOString();

const JSON_COLS = {
  tasks: ['people'],
  emails: ['suggested_reply_points', 'task_ids'],
  meetings: ['attendees', 'decisions', 'action_items'],
};
const BOOL_COLS = {
  tasks: ['blocking_me', 'overridden', 'reminded_t1', 'reminded_due'],
  emails: ['needs_reply'],
  meetings: ['needs_response', 'no_notes_needed', 'notes_needs_confirmation', 'is_key', 'cancelled'],
};

export function hydrate(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of JSON_COLS[table] || []) {
    try { out[c] = out[c] ? JSON.parse(out[c]) : []; } catch { out[c] = []; }
  }
  for (const c of BOOL_COLS[table] || []) out[c] = !!out[c];
  return out;
}

function dehydrate(table, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if ((JSON_COLS[table] || []).includes(k)) out[k] = JSON.stringify(v ?? []);
    else if ((BOOL_COLS[table] || []).includes(k)) out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

export function insert(table, obj) {
  const row = dehydrate(table, obj);
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`;
  const info = db.prepare(sql).run(prefix(row));
  return Number(info.lastInsertRowid);
}

export function update(table, id, obj) {
  const row = dehydrate(table, obj);
  if (table === 'tasks') row.updated_at = nowIso();
  const cols = Object.keys(row);
  if (!cols.length) return;
  const sql = `UPDATE ${table} SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @__id`;
  db.prepare(sql).run(prefix({ ...row, __id: id }));
}

export function get(table, id) {
  return hydrate(table, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}

export function all(table, sql, params = []) {
  return db.prepare(sql).all(...params).map(r => hydrate(table, r));
}

export function one(table, sql, params = []) {
  return hydrate(table, db.prepare(sql).get(...params));
}

// node:sqlite named params need the sigil in the key
function prefix(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out['@' + k] = v;
  return out;
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- settings ----
export const DEFAULT_SETTINGS = {
  sender_blocklist: ['noreply', 'no-reply', 'donotreply', 'notifications@', 'newsletter', 'mailer-daemon'],
  key_meeting_keywords: ['board', 'investor', 'client', 'review', 'launch', 'management'],
  reminder_times: {
    morning_brief: '08:30',
    tomorrow_preview: '19:00',
    follow_up_chase: '11:00',
    weekly_wrap: 'Fri 18:00',
  },
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (r.key === 'roles' || r.key === 'projects') continue; // read via readRoles()/readProjects()
    try { s[r.key] = JSON.parse(r.value); } catch { /* ignore bad row */ }
  }
  return s;
}

export function putSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

// ---- people / roles ----
const ROLES_PATH = path.join(ROOT, 'config', 'roles.json');
const PROJECTS_PATH = path.join(ROOT, 'config', 'projects.json');

// Edits made on the dashboard live in the DB, so a git redeploy doesn't overwrite them.
// The files in config/ are the defaults until the first dashboard edit.
const storedSetting = key => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
};

export function readRoles() {
  return storedSetting('roles') || JSON.parse(fs.readFileSync(ROLES_PATH, 'utf8'));
}

export function writeRoles(roles) {
  putSettings({ roles });
  seedPeople();
}

export function readProjects() {
  return storedSetting('projects') || JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')).projects.map(p => p.tag);
}

export function writeProjects(tags) {
  putSettings({ projects: tags });
}

export function seedPeople() {
  const roles = readRoles();
  tx(() => {
    db.exec('DELETE FROM people');
    const stmt = db.prepare('INSERT INTO people (name, email, team, role, owns) VALUES (?, ?, ?, ?, ?)');
    for (const p of roles.people || []) {
      stmt.run(p.name, p.email ? p.email.toLowerCase() : null, p.team ?? null, p.role ?? null, p.owns ?? null);
    }
  });
}
seedPeople();

// ---- reminders_log (dedupe) ----
export function alreadySent(dedupeKey) {
  return !!db.prepare('SELECT 1 FROM reminders_log WHERE dedupe_key = ?').get(dedupeKey);
}

export function logSend({ type, taskId = null, dedupeKey, channel = 'whatsapp', payload }) {
  db.prepare('INSERT OR IGNORE INTO reminders_log (type, task_id, dedupe_key, channel, payload) VALUES (?, ?, ?, ?, ?)')
    .run(type, taskId, dedupeKey, channel, payload);
}

// ---- sync status ----
export function markSync(source, error = null) {
  const t = nowIso();
  db.prepare(`INSERT INTO sync_status (source, last_run_at, last_ok_at, last_error) VALUES (?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at,
      last_ok_at = COALESCE(excluded.last_ok_at, sync_status.last_ok_at), last_error = excluded.last_error`)
    .run(source, t, error ? null : t, error ? String(error).slice(0, 500) : null);
}

export function getSyncStatus() {
  return db.prepare('SELECT * FROM sync_status').all();
}

// ---- retention (SPEC §8) ----
export function purgeOldEmailBodies() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  db.prepare('UPDATE emails SET body = NULL WHERE body IS NOT NULL AND received_at < ?').run(cutoff);
}
