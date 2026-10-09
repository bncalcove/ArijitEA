import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT } from './db.js';
import tasksRoutes from './routes/tasks.js';
import inboxRoutes from './routes/inbox.js';
import meetingsRoutes from './routes/meetings.js';
import settingsRoutes from './routes/settings.js';
import { start as startScheduler, runJob, MANUAL_SOURCES } from './jobs/scheduler.js';
import { oauthClient, GOOGLE_SCOPES, googleEnabled } from './integrations/google.js';
import { aiProvider } from './integrations/anthropic.js';

const { PORT = 3000, DASHBOARD_PASSWORD, SESSION_SECRET } = process.env;
if (!DASHBOARD_PASSWORD || !SESSION_SECRET) {
  console.error('Set DASHBOARD_PASSWORD and SESSION_SECRET in .env (see .env.example).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // behind HTTPS reverse proxy / VPN
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'ea.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 14 * 864e5 },
}));
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});

// ---- auth ----
const attempts = new Map(); // ip -> {count, until}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginPage = (error = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EA — Sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1f3d;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
form{background:#fff;padding:32px;border-radius:12px;width:min(340px,90vw);box-shadow:0 10px 40px #0004}
h1{margin:0 0 4px;font-size:20px;color:#0f1f3d}p{margin:0 0 20px;color:#667;font-size:14px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ccd;border-radius:8px;font-size:15px}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#c9a227;color:#0f1f3d;font-weight:600;font-size:15px;cursor:pointer}
.err{color:#c0392b;font-size:13px;margin-top:10px}</style></head><body>
<form method="post" action="/login"><h1>Ari's EA</h1><p>Enter the dashboard password</p>
<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">Sign in</button>${error ? `<div class="err">${error}</div>` : ''}</form></body></html>`;

app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).send(loginPage('Too many attempts. Try again in 15 minutes.'));
  if (safeEqual(req.body.password || '', DASHBOARD_PASSWORD)) {
    attempts.delete(ip);
    return req.session.regenerate(() => { req.session.authed = true; res.redirect('/'); });
  }
  a.count += 1;
  if (a.count >= 5) { a.until = Date.now() + 15 * 60e3; a.count = 0; }
  attempts.set(ip, a);
  res.status(401).send(loginPage('Wrong password.'));
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.use((req, res, next) => {
  if (req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  res.redirect('/login');
});

// ---- Google OAuth helper: visit /auth/google once to get GOOGLE_REFRESH_TOKEN ----
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(400).send('Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI first.');
  req.session.oauthState = crypto.randomBytes(16).toString('hex');
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES, state: req.session.oauthState }));
});
app.get('/oauth2callback', async (req, res) => {
  if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid OAuth response.');
  try {
    const { tokens } = await oauthClient().getToken(req.query.code);
    res.type('html').send(`<p>Copy this into <code>.env</code> as <b>GOOGLE_REFRESH_TOKEN</b>, then restart the server:</p>
      <textarea rows="4" cols="90" readonly>${tokens.refresh_token || '(no refresh token returned — revoke access at myaccount.google.com/permissions and retry)'}</textarea>`);
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
  console.log(`EA dashboard on http://localhost:${PORT}  (AI: ${aiProvider()}, Google: ${googleEnabled() ? 'on' : 'OFF'}, WhatsApp: ${process.env.WHATSAPP_ENDPOINT ? 'on' : 'dry-run'})`);
  if (process.env.NO_SCHEDULER !== '1') {
    startScheduler();
    runJob(...MANUAL_SOURCES.calendar).then(() => runJob(...MANUAL_SOURCES.gmail));
  }
});
