import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, putSettings, readRoles, writeRoles, readProjects, ROOT } from '../db.js';
import { jobTable, reload } from '../jobs/scheduler.js';

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
    const file = path.join(ROOT, 'config', 'projects.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
    const next = projects.map(String).filter(Boolean).map(tag => current.find(p => p.tag === tag) || { tag, keywords: [] });
    fs.writeFileSync(file, JSON.stringify({ projects: next }, null, 2) + '\n');
  }
  res.json({ ...getSettings(), roles: readRoles(), projects: readProjects() });
});

export default r;
