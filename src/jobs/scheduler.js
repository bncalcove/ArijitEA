// All node-cron jobs, in IST (SPEC §5). reload() re-reads reminder times from settings.
import cron from 'node-cron';
import { getSettings, purgeOldEmailBodies } from '../db.js';
import { syncGmail } from './syncGmail.js';
import { syncCalendar } from './syncCalendar.js';
import { notesCheck } from './meetingNotes.js';
import { morningBrief, tomorrowPreview, dueNudge, followUpChase, weeklyWrap } from './reminders.js';

const TZ = 'Asia/Kolkata';
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const running = new Set();
let tasks = [];

/** Run a job with an overlap guard so a slow Gmail sync never stacks up. */
export async function runJob(name, fn) {
  if (running.has(name)) return { skipped: 'already running' };
  running.add(name);
  try {
    const r = await fn();
    return r;
  } catch (e) {
    console.error(`[job:${name}]`, e.message);
    return { error: e.message };
  } finally {
    running.delete(name);
  }
}

function hhmmToCron(hhmm, dow = '*') {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`Bad time "${hhmm}"`);
  return `${m} ${h} * * ${dow}`;
}

function weeklyToCron(spec) {
  const [day, time] = String(spec).trim().split(/\s+/);
  const dow = DAYS[day?.slice(0, 3).toLowerCase()];
  if (dow === undefined) throw new Error(`Bad weekly spec "${spec}"`);
  return hhmmToCron(time, dow);
}

export function jobTable() {
  const t = getSettings().reminder_times;
  return [
    ['syncGmail', '*/10 7-22 * * *', syncGmail],
    ['syncGmail', '0 23 * * *', syncGmail],
    ['syncCalendar', '*/15 * * * *', syncCalendar],
    ['notesCheck', '*/30 * * * *', notesCheck],
    ['morningBrief', hhmmToCron(t.morning_brief), morningBrief],
    ['tomorrowPreview', hhmmToCron(t.tomorrow_preview), tomorrowPreview],
    ['dueNudge', '*/5 * * * *', dueNudge],
    ['followUpChase', hhmmToCron(t.follow_up_chase), followUpChase],
    ['weeklyWrap', weeklyToCron(t.weekly_wrap), weeklyWrap],
    ['purgeEmailBodies', '15 3 * * *', async () => purgeOldEmailBodies()],
  ];
}

export function start() {
  stop();
  tasks = jobTable().map(([name, expr, fn]) => cron.schedule(expr, () => runJob(name, fn), { timezone: TZ }));
  console.log(`[scheduler] ${tasks.length} jobs scheduled (${TZ})`);
}

export function stop() {
  for (const t of tasks) t.stop();
  tasks = [];
}

export const reload = start;

// POST /api/sync/:source → [job name (shares the overlap guard with cron), fn]
export const MANUAL_SOURCES = {
  gmail: ['syncGmail', syncGmail],
  calendar: ['syncCalendar', syncCalendar],
  notes: ['notesCheck', notesCheck],
  morning: ['morningBrief', morningBrief],
  t1: ['tomorrowPreview', tomorrowPreview],
  chase: ['followUpChase', followUpChase],
  weekly: ['weeklyWrap', weeklyWrap],
};
