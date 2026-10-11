import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, DATA_DIR } from './db.js';
import {
  sessionSecret, passwordConfigured, verifyPassword, setPassword, setupCodeFor, consumeSetupCode, saveSecrets,
  granolaToken, safeEqual,
} from './config.js';
import { processNotes } from './jobs/meetingNotes.js';
import { normaliseNotes } from './integrations/granola.js';
import tasksRoutes from './routes/tasks.js';
import inboxRoutes from './routes/inbox.js';
import meetingsRoutes from './routes/meetings.js';
import settingsRoutes from './routes/settings.js';
import { start as startScheduler, runJob, MANUAL_SOURCES } from './jobs/scheduler.js';
import { oauthClient, GOOGLE_SCOPES, googleEnabled, resetGoogle } from './integrations/google.js';
import { aiProvider } from './integrations/anthropic.js';

const PORT = process.env.PORT || 3000;
// Served under a sub-path behind the proxy, e.g. https://employees.alcoverealty.in/p/ea/
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const to = p => BASE + p;

const app = express();
// Accept requests with or without the prefix (works whether the proxy strips it or not).
app.use((req, res, next) => {
  if (BASE && req.url.startsWith(BASE) && (req.url.length === BASE.length || '/?'.includes(req.url[BASE.length]))) {
    const rest = req.url.slice(BASE.length);
    // The dashboard uses relative URLs, so it must be loaded as /p/ea/ (with the slash).
    if (!rest.startsWith('/')) return res.redirect(301, BASE + '/' + rest);
    req.url = rest;
  }
  next();
});
app.set('trust proxy', 1); // behind HTTPS reverse proxy / VPN
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'ea.sid',
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 14 * 864e5 },
}));
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});

/** Public URL of the app as the browser sees it, e.g. https://employees.alcoverealty.in/p/ea */
function publicBase(req) {
  const host = req.get('host') || 'localhost';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${local ? req.protocol : 'https'}://${host}${BASE}`;
}
app.locals.publicBase = publicBase;

// Unauthenticated liveness probe for the deploy system.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---- Granola webhook (Zapier/Make "new note" → POST here). Auth = secret token in the URL. ----
const pick = (o, keys) => keys.map(k => o?.[k]).find(v => typeof v === 'string' && v.trim());
app.post('/hooks/granola/:token', (req, res) => {
  if (!safeEqual(req.params.token, granolaToken())) return res.status(403).json({ error: 'Bad token' });
  const b = req.body || {};
  const notes = normaliseNotes(pick(b, ['notes', 'content', 'markdown', 'text', 'body', 'note', 'summary', 'enhanced_notes']) || '');
  if (!notes) return res.status(400).json({ error: 'No notes text found (send it as "notes" or "content")' });
  const title = pick(b, ['title', 'meeting_title', 'name', 'subject']) || '';
  const when = pick(b, ['start_time', 'meeting_date', 'date', 'created_at', 'createdAt']);
  const receivedAt = when && !isNaN(new Date(when)) ? new Date(when).toISOString() : new Date().toISOString();
  // Reply right away; AI processing can take longer than Zapier waits.
  res.status(202).json({ ok: true, queued: true });
  processNotes({ text: title ? `# ${title}\n\n${notes}` : notes, source: 'webhook', subject: title, receivedAt })
    .then(m => console.log(`[granola] notes saved to "${m.title}" (${m.action_items.length} action items)`))
    .catch(e => console.error('[granola] processing failed:', e.message));
});

// ---- auth ----
const attempts = new Map(); // ip -> {count, until}
function throttled(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now();
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60e3; a.count = 0; }
  attempts.set(ip, a);
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EA — ${title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1f3d;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
form{background:#fff;padding:32px;border-radius:12px;width:min(360px,90vw);box-shadow:0 10px 40px #0004}
h1{margin:0 0 4px;font-size:20px;color:#0f1f3d}p{margin:0 0 18px;color:#667;font-size:14px}
label{display:block;font-size:12px;font-weight:600;color:#667;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ccd;border-radius:8px;font-size:15px}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:#c9a227;color:#0f1f3d;font-weight:600;font-size:15px;cursor:pointer}
.err{color:#c0392b;font-size:13px;margin-top:10px}</style></head><body>${body}</body></html>`;

const loginPage = (error = '') => page('Sign in', `<form method="post" action="${to('/login')}"><h1>Ari's EA</h1><p>Enter the dashboard password</p>
<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">Sign in</button>${error ? `<div class="err">${error}</div>` : ''}</form>`);

const setupPage = (error = '') => page('Set up', `<form method="post" action="${to('/setup')}"><h1>Set up Ari's EA</h1>
<p>Choose the dashboard password. The setup code is printed in the server / deploy log.</p>
<label>Setup code</label><input name="code" autocomplete="off" required autofocus>
<label>New password (8+ characters)</label><input type="password" name="password" minlength="8" autocomplete="new-password" required>
<label>Confirm password</label><input type="password" name="confirm" minlength="8" autocomplete="new-password" required>
<button type="submit">Save and sign in</button>${error ? `<div class="err">${error}</div>` : ''}</form>`);

function login(req, res) {
  req.session.regenerate(() => { req.session.authed = true; res.redirect(to('/')); });
}

app.get('/setup', (req, res) => (passwordConfigured() ? res.redirect(to('/login')) : res.send(setupPage())));
app.post('/setup', (req, res) => {
  if (passwordConfigured()) return res.redirect(to('/login'));
  if (throttled(req.ip)) return res.status(429).send(setupPage('Too many attempts. Try again in 15 minutes.'));
  const { code, password, confirm } = req.body || {};
  if (password !== confirm) return res.status(400).send(setupPage('Passwords do not match.'));
  if (!consumeSetupCode(code)) { recordFailure(req.ip); return res.status(401).send(setupPage('Wrong setup code — check the server log.')); }
  try { setPassword(password); } catch (e) { return res.status(400).send(setupPage(e.message)); }
  login(req, res);
});

app.get('/login', (req, res) => (passwordConfigured() ? res.send(loginPage()) : res.redirect(to('/setup'))));
app.post('/login', (req, res) => {
  if (!passwordConfigured()) return res.redirect(to('/setup'));
  if (throttled(req.ip)) return res.status(429).send(loginPage('Too many attempts. Try again in 15 minutes.'));
  if (verifyPassword(req.body?.password || '')) { attempts.delete(req.ip); return login(req, res); }
  recordFailure(req.ip);
  res.status(401).send(loginPage('Wrong password.'));
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect(to('/login'))));

app.use((req, res, next) => {
  if (req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  res.redirect(to(passwordConfigured() ? '/login' : '/setup'));
});

// ---- Google OAuth: Settings → Connections → "Connect Google" ----
const redirectUri = req => process.env.GOOGLE_REDIRECT_URI || `${publicBase(req)}/oauth2callback`;

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('Add the Google client ID and secret in Settings → Connections first.');
  }
  req.session.oauthState = crypto.randomBytes(16).toString('hex');
  req.session.oauthRedirect = redirectUri(req);
  res.redirect(oauthClient(req.session.oauthRedirect).generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES, state: req.session.oauthState,
  }));
});
app.get('/oauth2callback', async (req, res) => {
  if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid OAuth response.');
  try {
    const { tokens } = await oauthClient(req.session.oauthRedirect).getToken(req.query.code);
    if (!tokens.refresh_token) {
      return res.status(400).send('Google returned no refresh token. Remove access at myaccount.google.com/permissions and connect again.');
    }
    saveSecrets({ GOOGLE_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_REDIRECT_URI: req.session.oauthRedirect });
    resetGoogle();
    runJob(...MANUAL_SOURCES.calendar).then(() => runJob(...MANUAL_SOURCES.gmail));
    res.redirect(to('/?connected=google'));
  } catch (e) {
    res.status(500).send(`OAuth failed: ${e.message}`);
  }
});

// ---- API ----
app.use('/api', tasksRoutes, inboxRoutes, meetingsRoutes, settingsRoutes);

app.post('/api/sync/:source', async (req, res) => {
  const job = MANUAL_SOURCES[req.params.source];
  if (!job) return res.status(400).json({ error: `Unknown source. Use one of: ${Object.keys(MANUAL_SOURCES).join(', ')}` });
  res.json(await runJob(...job));
});

app.get('/api/health', (req, res) => res.json({ ok: true, ai: aiProvider(), google: googleEnabled(), whatsapp: !!process.env.WHATSAPP_ENDPOINT }));

app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`EA dashboard listening on port ${PORT}  (AI: ${aiProvider()}, Google: ${googleEnabled() ? 'on' : 'OFF'}, WhatsApp: ${process.env.WHATSAPP_ENDPOINT ? 'on' : 'dry-run'}, data: ${DATA_DIR})`);
  const code = setupCodeFor();
  if (code) {
    console.log('================================================================');
    console.log(`  FIRST-RUN SETUP: open the dashboard and enter setup code ${code}`);
    console.log('  to choose the dashboard password. (A new code is shown on each restart.)');
    console.log('================================================================');
  }
  if (process.env.NO_SCHEDULER !== '1') {
    startScheduler();
    runJob(...MANUAL_SOURCES.calendar).then(() => runJob(...MANUAL_SOURCES.gmail));
  }
});
