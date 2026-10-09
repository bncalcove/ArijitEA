// Runtime configuration that works without a .env file (git-only deploys):
// - integration keys can be entered on the dashboard and are stored in the `secrets` table;
//   a real environment variable always wins over a stored value.
// - SESSION_SECRET is generated once and stored if not provided.
// - the dashboard password is either DASHBOARD_PASSWORD or a scrypt hash set on first run
//   via /setup, which needs a one-time code printed to the server log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from './db.js';

export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_REFRESH_TOKEN',
  'WHATSAPP_ENDPOINT', 'WHATSAPP_AUTH_TOKEN', 'WHATSAPP_TO_NUMBER',
];
// Values that are not sensitive and can be shown back in full.
const SHOW_IN_FULL = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_REDIRECT_URI', 'WHATSAPP_ENDPOINT', 'WHATSAPP_TO_NUMBER']);

const fromEnv = new Set(SECRET_KEYS.filter(k => process.env[k]));

const getRow = key => db.prepare('SELECT value FROM secrets WHERE key = ?').get(key)?.value;
const setRow = (key, value) => db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const delRow = key => db.prepare('DELETE FROM secrets WHERE key = ?').run(key);

/** Copy stored keys into process.env (env vars set by the host take precedence). */
export function loadSecrets() {
  for (const k of SECRET_KEYS) {
    if (fromEnv.has(k)) continue;
    const v = getRow(k);
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
}

/** patch: { KEY: "value" | null }. null or "" clears a stored value. Returns keys that changed. */
export function saveSecrets(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SECRET_KEYS.includes(k) || fromEnv.has(k)) continue;
    const value = typeof v === 'string' ? v.trim() : v;
    if (value) setRow(k, value);
    else delRow(k);
    changed.push(k);
  }
  loadSecrets();
  return changed;
}

export function secretStatus() {
  return Object.fromEntries(SECRET_KEYS.map(k => {
    const v = process.env[k];
    const source = fromEnv.has(k) ? 'env' : v ? 'dashboard' : null;
    const shown = !v ? '' : SHOW_IN_FULL.has(k) ? v : `••••${v.slice(-4)}`;
    return [k, { set: !!v, source, value: shown }];
  }));
}

export function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getRow('_session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setRow('_session_secret', s); }
  return s;
}

// ---------- dashboard password ----------
// Order: DASHBOARD_PASSWORD env → hash set on the dashboard (DB) → initial hash committed in
// config/admin.json (only a scrypt hash is in git, never the password).
function committedHash() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'admin.json'), 'utf8')).password_hash || null;
  } catch { return null; }
}
const currentHash = () => getRow('_password_hash') || committedHash();

export const passwordFromEnv = () => !!process.env.DASHBOARD_PASSWORD;
export const passwordConfigured = () => passwordFromEnv() || !!currentHash();

const sha = v => crypto.createHash('sha256').update(String(v)).digest();
export const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export function verifyPassword(pw) {
  if (passwordFromEnv()) return safeEqual(pw, process.env.DASHBOARD_PASSWORD);
  const stored = currentHash();
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return safeEqual(test, hash);
}

export function setPassword(pw) {
  if (passwordFromEnv()) throw new Error('Password is set by the DASHBOARD_PASSWORD environment variable');
  if (String(pw).length < 8) throw new Error('Use at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  setRow('_password_hash', `${salt}:${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`);
}

// One-time setup code, regenerated on every start while no password exists.
let setupCode = null;
export function setupCodeFor() {
  if (passwordConfigured()) return null;
  setupCode ??= crypto.randomBytes(4).toString('hex').toUpperCase();
  return setupCode;
}
export function consumeSetupCode(code) {
  const ok = !!setupCode && safeEqual(String(code || '').trim().toUpperCase(), setupCode);
  if (ok) setupCode = null;
  return ok;
}

loadSecrets();
