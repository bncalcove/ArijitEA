# Ari's EA Agent + Dashboard

This app reads Gmail and Google Calendar and turns emails and Granola meeting notes into tasks. It sorts
each task into **My Job** or **Not My Job** and sends WhatsApp reminders and briefs. The dashboard runs
on a single page. The full spec is in [SPEC.md](SPEC.md).

## 1. Install
Requires Node.js 22.13 or newer. The app uses the built-in `node:sqlite`, so there are no native builds.
```bash
npm install
cp .env.example .env      # then fill it in (next steps)
npm start                 # http://localhost:3000
```
The app runs without any keys. AI, Google and WhatsApp each switch on once their variables are set.
Until then WhatsApp messages are printed to the console (dry run).

## Deploying from git, with no `.env` (in-house deploy system)
You don't need any environment variables:
1. Push to git and let the system deploy. The app listens on `$PORT` (the platform sets it) and answers `GET /healthz`.
2. Find this line in the deploy log: `FIRST-RUN SETUP: ... enter setup code XXXXXXXX`.
3. Open the app URL, enter that code and choose the dashboard password. A new code is printed on each restart until a password is set.
4. Go to **Settings → Connections** and enter the Google client ID and secret, the WhatsApp details and, optionally, an Anthropic API key. Then click **Connect Google**. The keys are stored in the app database, never in git.

**Persistent data.** The database holds tasks, notes, the password and the keys. It is stored in
`DATA_DIR` if that's set; otherwise in `/data` if that folder exists and is writable; otherwise in `./data`.
Ask the infra team to mount a persistent volume at `/data`. Without it, every redeploy starts empty and
you have to run setup again.

**AI on a server.** The Claude Code login only exists on a machine where Claude Code is installed and
logged in. On a deploy server, add an Anthropic API key in Connections. Without one, the app runs in
rule-based mode.

## 2. Configure `.env` (optional: local runs, or hosts that support env vars)
Any variable set here overrides the dashboard value. Every variable is optional.
| Variable | What to put |
|---|---|
| `DASHBOARD_PASSWORD` | Login password for the dashboard |
| `SESSION_SECRET` | A long random string, e.g. `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` |
| `AI_PROVIDER` | `auto` (default): uses `ANTHROPIC_API_KEY` if it's set; otherwise uses the **Claude Code login on this machine** (`claude -p`, no API key needed); if neither is available, falls back to simple rules. You can also force `api`, `claude-cli` or `off` |
| `CLAUDE_CLI_PATH` | Optional. Path to `claude.exe` if it isn't on PATH or bundled with the VS Code extension (it's found automatically in either place) |
| `ANTHROPIC_API_KEY` | Optional. Get one from console.anthropic.com. `ANTHROPIC_MODEL` defaults to `claude-opus-5-5` |
| `GOOGLE_*` | See step 3 |
| `NOTES_EMAIL_TAG` | Subject tag for emailed Granola notes (default `[EA-NOTES]`) |
| `WHATSAPP_*` | See step 4 |

## 3. Connect Google (Gmail + Calendar, read-only)
1. In Google Cloud Console, create a project and enable the **Gmail API** and the **Google Calendar API**.
2. Under OAuth consent screen, choose Internal if you're on Workspace, and add the scopes `gmail.readonly` and `calendar.readonly`.
3. Create an OAuth client of type **Web application**. Use `http://localhost:3000/oauth2callback` as the redirect URI, or your HTTPS URL followed by `/oauth2callback`.
4. Enter the client ID and secret in **Settings → Connections** (or in `.env`) and save.
5. Click **Connect Google** and approve access. The refresh token is saved automatically and the first sync starts.

## 4. Connect WhatsApp
`src/integrations/whatsapp.js` sends a request to `WHATSAPP_ENDPOINT`:
```
POST {"to": WHATSAPP_TO_NUMBER, "text": "..."}
Authorization: Bearer WHATSAPP_AUTH_TOKEN
```
Point the endpoint at your provider: a Meta Cloud API relay, a Twilio Function, Interakt, Gupshup and so on.
If your provider expects a different request body, edit only `buildBody()`. Every message sent is logged in
`reminders_log` with a unique key, so the same message is never sent twice.

## 5. Teach it Ari's job
- `CLAUDE.md` → **Role rules**: plain-English rules for what is Ari's job, plus priority rules.
- `config/roles.json`: Ari's details, company email domains, and team members with what each person owns.
- `config/projects.json`: project tags.

You can also edit these from **Settings** on the dashboard. Each "Wrong bucket?" correction is used as
an example the next time a task is classified.

## Schedules (IST)
| Job | When | What it does |
|---|---|---|
| Gmail sync | Every 10 min, 7am–11pm | Processes new inbox mail |
| Calendar sync | Every 15 min | Syncs the next 14 days and adds prep tasks for key meetings |
| Notes check | Every 30 min | Sends a nudge for meetings that ended 2h+ ago without notes |
| Morning brief | 08:30 | WhatsApp summary of the day |
| Tomorrow preview | 19:00 | WhatsApp preview of tomorrow |
| Due nudges | Every 5 min | Reminders for tasks due soon |
| Follow-up chase | 11:00 | People to chase today |
| Weekly wrap | Fri 18:00 | Summary of the week |
| Email body purge | 03:15 | Deletes email bodies older than 30 days |

You can change the brief, preview, chase and weekly times in Settings. Pressing the sync dot in the top
bar runs Gmail and Calendar sync immediately. You can also call `POST /api/sync/{gmail|calendar|notes|morning|t1|chase|weekly}` directly.

## Meeting notes (Granola)
There are two ways to add notes:
- Use **Paste notes** in the dashboard, either on a specific meeting or from the general button.
- Email the notes to yourself with `[EA-NOTES]` in the subject.

Notes are matched to a meeting by title and time. If the match is unclear, the app picks the meeting
that ended most recently in the last 24h and marks it **Auto-matched — check**. Action items assigned to
other people become Not My Job tasks with that person as owner.

## Security (SPEC §8)
- Login uses a password and an httpOnly session cookie. There's a lockout after 5 failed attempts. Run it behind HTTPS or the Alcove VPN; the cookie becomes `secure` automatically over HTTPS.
- Email content is processed only on the server. The Anthropic API is the only external AI service. This applies in both modes, the API key and the Claude Code login, because both send email text to Anthropic. **Get IT/management sign-off before turning on Gmail sync.**
- Email bodies are deleted after 30 days; summaries are kept. The database is `data/ea.db`, which is gitignored.

## Layout
`src/server.js` handles the app and login. `src/db.js` holds the schema and helpers. `src/ai/*` contains the
prompts, extraction and classification. `src/integrations/*` connects to Gmail, Calendar, Granola, WhatsApp
and Anthropic. `src/jobs/*` holds the cron jobs. `src/routes/*` is the API. `public/index.html` is the dashboard.
