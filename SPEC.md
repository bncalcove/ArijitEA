# SPEC.md — Ari's EA Agent + Dashboard

## 1. Folder structure
```
ari-ea/
  CLAUDE.md
  SPEC.md
  PROMPTS.md
  README.md
  .env.example
  package.json
  config/
    roles.json          # people, teams, what each owns
    projects.json       # project tags
  data/ea.db            # SQLite (gitignored)
  public/index.html     # the dashboard (single file)
  src/
    server.js           # Express app, auth, static, API routes
    db.js               # schema + migrations + query helpers
    ai/
      extract.js        # email/meeting → summary + tasks (JSON)
      classify.js       # My Job / Not My Job + owner + priority
      prompts.js        # all prompt templates in one place
    integrations/
      gmail.js
      calendar.js
      granola.js        # parse pasted/emailed Granola notes
      whatsapp.js       # sendWhatsApp(text)
      anthropic.js
    jobs/
      scheduler.js      # all node-cron jobs registered here
      syncGmail.js
      syncCalendar.js
      meetingNotes.js   # match notes to events, run 4c, missing-notes nudges
      reminders.js      # morning brief, T-1, due nudges, follow-ups
    routes/
      tasks.js
      inbox.js
      meetings.js
      settings.js
```

## 2. .env.example
```
PORT=3000
DASHBOARD_PASSWORD=
SESSION_SECRET=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_REFRESH_TOKEN=
NOTES_EMAIL_TAG=[EA-NOTES]
WHATSAPP_ENDPOINT=
WHATSAPP_AUTH_TOKEN=
WHATSAPP_TO_NUMBER=
TZ=Asia/Kolkata
```

## 3. Database tables

**tasks**
id, title, description, source (`email|calendar|meeting|manual|whatsapp`), source_ref, project, bucket (`mine|not_mine`), owner, blocking_me (bool), ai_bucket, ai_confidence (0–1), overridden (bool), priority (`P1–P4`), priority_reason, due_at, people (JSON array), status (`open|in_progress|waiting|done|dropped`), follow_up_at, reminded_t1 (bool), reminded_due (bool), created_at, updated_at, completed_at

**emails**
id, gmail_id (unique), thread_id, from_name, from_email, subject, received_at, summary (≈1-minute read, max 120 words), needs_reply (bool), reply_by, sentiment/urgency, task_ids (JSON), processed_at, status (`new|seen|replied|archived`)

**meetings**
id, calendar_event_id (unique), title, start_at, end_at, platform (`meet|zoom|teams|other`), join_link, organizer, attendees (JSON), rsvp_status, needs_response (bool), prep_note, notes_source (`paste|email`), notes_received_at, notes_raw, notes_summary, no_notes_needed (bool), decisions (JSON), action_items (JSON), processed_at

**overrides**
id, task_id, from_bucket, to_bucket, from_owner, to_owner, task_title, note, created_at. The last 30 rows are sent as few-shot examples to classify.js.

**people**
id, name, email, team, role, owns (text). Seeded from config/roles.json.

**reminders_log**
id, type, task_id, sent_at, channel, payload. This prevents duplicate WhatsApp sends.

## 4. AI pipeline

### 4a. Email → summary + tasks (extract.js)
Input is sender, subject, body (stripped of signatures and quoted history) and thread context. Output is JSON only:
```json
{
  "summary": "≤120 words: who, what they want, by when, what's at stake",
  "needs_reply": true,
  "reply_by": "ISO or null",
  "suggested_reply_points": ["..."],
  "tasks": [
    {"title": "", "description": "", "due_at": "ISO or null", "people": [""], "project": ""}
  ]
}
```
Skip newsletters, promos and automated notifications, using Gmail category plus a sender blocklist in settings.

### 4b. Task → bucket + owner + priority (classify.js)
The prompt includes the role rules from CLAUDE.md, config/roles.json, and the last 30 overrides as examples. Output:
```json
{"bucket":"mine|not_mine","owner":"","blocking_me":false,"confidence":0.0,
 "priority":"P1","priority_reason":"","project":"","follow_up_at":"ISO or null"}
```
If confidence is below 0.6, the task shows a "Review" badge on the dashboard.

### 4c. Meeting transcript → notes + tasks
Granola notes (pasted or emailed) plus the matched calendar event go in. Match on the meeting title and time; if unclear, take the closest event that ended in the last 24h and flag it for confirmation. Granola's notes are already structured, so the AI's main job is pulling out action items and owners. The output contains a 5-line summary, the decisions, and action items in the same task shape as 4a, which then go through classify.js. Action items assigned to others become Not My Job with that person as owner.

## 5. Schedulers (all IST)
| Job | When | What |
|---|---|---|
| syncGmail | every 10 min, 7am–11pm | new inbox mail → extract → classify |
| syncCalendar | every 15 min | next 14 days; flag invites with no RSVP; add prep task 1 day before key meetings |
| Notes check | every 30 min | meetings that ended 2h+ ago with no notes → one WhatsApp nudge: "Paste Granola notes for <meeting>" (skip ones marked no notes needed) |
| Morning brief | 08:30 daily | WhatsApp: today's meetings, P1/P2 My Job, overdue, emails awaiting reply, Not-My-Job items to chase today |
| Tomorrow preview (T-1) | 19:00 daily | WhatsApp: "Tomorrow:" meetings + tasks due tomorrow with people involved |
| Due nudge | every 5 min | tasks due in the next 30 min, not yet reminded |
| Follow-up chase | 11:00 daily | Not My Job items where follow_up_at ≤ today, with a ready-to-send chase line per owner |
| Weekly wrap | Fri 18:00 | done this week, slipped, next week's P1s |

Every send is written to reminders_log, so nothing is sent twice.

## 6. API (all routes need the login session)
- `GET /api/today`: the strip data (counts, next meeting, overdue)
- `GET /api/tasks?bucket=&status=&project=&priority=`
- `POST /api/tasks`: quick add (title, due_at, people[], project, notes, bucket optional; AI fills the missing fields)
- `PATCH /api/tasks/:id`: edit, change status, override bucket/owner (writes to overrides)
- `GET /api/inbox?needs_reply=`
- `GET /api/meetings?range=`
- `POST /api/meetings/:id/notes`: paste Granola notes for a meeting (without an id, AI matches the notes to the closest event)
- `PATCH /api/meetings/:id`: mark no notes needed
- `POST /api/sync/:source`: manual "refresh now"
- `GET/PUT /api/settings`: blocklist, reminder times, roles

## 7. Dashboard (public/index.html)
The layout is desktop-first and stays usable on mobile.

1. **Top bar** (navy): "Good morning, Ari", the date in IST, a sync status dot, and a **+ Add Task** button in gold.
2. **Today strip**: cards for Next meeting (with join link), P1 count, Overdue (red), Awaiting my reply, and Chase today.
3. **Main area, two columns:**
   - **My Job**: a table with Priority, Task, Project, Due, People, Source, and Status, plus actions (Done, Snooze, Move to Not My Job).
   - **Not My Job**: a table with Task, **Owner**, Project, Follow-up date, Blocking me (badge), and Status, plus actions (Chase — copy message, Done, Move to My Job).
4. **Inbox digest**: email cards showing sender, subject, a ~1-minute summary, a reply-by chip, suggested reply points, extracted tasks, and an "Open in Gmail" link.
5. **Calendar**: today and the next 7 days, showing RSVP needed, platform icon, join link, prep notes, and a link to the meeting notes once processed.
6. **Meeting notes**: a list of past meetings, each with summary, decisions and action items. Each past meeting has a **Paste notes** button, and a general one sits at the top. Meetings without notes show an amber "Notes pending" badge with a "No notes needed" option.
7. **Add Task modal**: Task, Date and Time (IST), People (multi-entry with suggestions from the people table), Project (dropdown), Notes, and an optional bucket (if blank, AI decides). On save, a toast confirms "Reminder set for [date] + day-before at 7 pm."

Filters cover project, priority and status, with search across all sections. Auto-refresh runs every 2 minutes. The override control is a small "Wrong bucket?" toggle on every task row.

## 8. Security
- The dashboard is behind a password login with a session cookie, and should only be reachable over HTTPS or the Alcove VPN (decided by the tech person).
- Email content is processed only server-side, and the Anthropic API is the only external AI. Get IT/management sign-off on email data going to the API.
- Do not store full email bodies longer than 30 days; summaries can stay.
