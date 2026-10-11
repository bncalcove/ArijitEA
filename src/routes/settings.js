import { Router } from 'express';
import { getSettings, putSettings, readRoles, writeRoles, readProjects, writeProjects } from '../db.js';
import { jobTable, reload } from '../jobs/scheduler.js';
import { secretStatus, saveSecrets, passwordFromEnv, verifyPassword, setPassword, granolaToken } from '../config.js';
import { sendWhatsApp } from '../integrations/whatsapp.js';
import { resetGoogle } from '../integrations/google.js';
import { resetAnthropic, aiProvider } from '../integrations/anthropic.js';

const r = Router();

r.get('/settings', (req, res) => {
  res.json({ ...getSettings(), roles: readRoles(), projects: readProjects() });
});

r.put('/settings', (req, res) => {
  const { sender_blocklist, key_meeting_keywords, reminder_times, roles, projects } = req.body || {};
  const before = getSettings();
  const patch = {};
  if (Array.isArray(sender_blocklist)) patch.sender_blocklist = sender_blocklist.map(String).filter(Boolean);
  if (Array.isArray(key_meeting_keywords)) patch.key_meeting_keywords = key_meeting_keywords.map(String).filter(Boolean);
  if (reminder_times) patch.reminder_times = { ...before.reminder_times, ...reminder_times };
  putSettings(patch);

  try {
    jobTable(); // validates the reminder times
  } catch (e) {
    putSettings({ reminder_times: before.reminder_times });
    return res.status(400).json({ error: e.message });
  }
  if (patch.reminder_times) reload();

  if (roles) {
    if (!roles.me || !Array.isArray(roles.people)) return res.status(400).json({ error: 'roles needs "me" and "people"' });
    writeRoles(roles);
  }
  if (Array.isArray(projects)) {
    const tags = [...new Set(projects.map(String).map(t => t.trim()).filter(Boolean))];
    if (!tags.length) return res.status(400).json({ error: 'Keep at least one project' });
    writeProjects(tags);
  }
  res.json({ ...getSettings(), roles: readRoles(), projects: readProjects() });
});

// Integration keys entered on the dashboard. Values are never returned in full.
function connections(req, extra = {}) {
  const base = req.app.locals.publicBase(req);
  return {
    keys: secretStatus(),
    ai_provider: aiProvider(),
    google_redirect_uri: process.env.GOOGLE_REDIRECT_URI || `${base}/oauth2callback`,
    granola_webhook_url: `${base}/hooks/granola/${granolaToken()}`,
    ...extra,
  };
}

r.get('/connections', (req, res) => res.json(connections(req)));

r.put('/connections', (req, res) => {
  const changed = saveSecrets(req.body || {});
  if (changed.some(k => k.startsWith('GOOGLE_'))) resetGoogle();
  if (changed.includes('ANTHROPIC_API_KEY')) resetAnthropic();
  res.json(connections(req, { changed }));
});

r.post('/connections/granola/rotate', (req, res) => {
  granolaToken({ rotate: true });
  res.json(connections(req));
});

r.post('/connections/test/whatsapp', async (req, res) => {
  if (!process.env.WHATSAPP_ENDPOINT) return res.status(400).json({ error: 'Set the WhatsApp endpoint first' });
  try {
    const r2 = await sendWhatsApp(`✅ Test from Ari's EA — WhatsApp is connected. (${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})`);
    res.json(r2);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

r.put('/password', (req, res) => {
  if (passwordFromEnv()) return res.status(400).json({ error: 'Password is set by an environment variable on the server' });
  const { current, next: newPassword } = req.body || {};
  if (!verifyPassword(current || '')) return res.status(401).json({ error: 'Current password is wrong' });
  try { setPassword(newPassword || ''); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ ok: true });
});

export default r;
