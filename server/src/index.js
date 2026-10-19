const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cfg = require('./config');
const api = require('./routes/api');
const { startAutoSync } = require('./services/sync');

const app = express();
app.use(cors());
// The raw body is kept for the Shopify webhook only: its signature is computed over the exact bytes.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/webhook/shopify')) req.rawBody = buf; } }));
app.set('trust proxy', 1); // behind Render / Vercel: req.ip is the real caller (used by the sign-in brake)

app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));

// External trigger for the sheet sync: cron-job.org / UptimeRobot / GitHub Actions call this every 5-15 min.
// It also keeps a sleeping host (Render free plan) awake. Protected by CRON_SECRET, not the dashboard password.
const sync = require('./services/sync');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && require('crypto').timingSafeEqual(x, y); };
const cronAuth = (req, res) => {
  if (!cfg.cronSecret) { res.status(503).json({ error: 'CRON_SECRET is not set on the server' }); return false; }
  const key = req.get('x-cron-key') || req.query.key || '';
  if (!safeEq(key, cfg.cronSecret)) { res.status(401).json({ error: 'Bad key' }); return false; }
  return true;
};
// Instant sync: called by the Google Sheet (Apps Script, see apps-script/) whenever a row is added or changed.
app.all('/api/webhook/sheet', (req, res) => {
  if (!cronAuth(req, res)) return;
  sync.requestSync('webhook');
  res.status(202).json({ queued: true });
});
// New order in Shopify: Shopify calls this (subscribe orders/create and orders/updated to <server>/api/webhook/shopify) and the order
// shows up in the Shopify Desk within seconds, instead of waiting for the next 2-minute pull.
app.post('/api/webhook/shopify', (req, res) => {
  const { verifyShopifyHmac } = require('./lib/shopifyHmac');
  if (!verifyShopifyHmac(req.rawBody, req.get('x-shopify-hmac-sha256'), cfg.shopify.clientSecret)) return res.status(401).json({ error: 'Bad signature' });
  res.status(200).json({ ok: true });
  const shopifySync = require('./services/shopifySync');
  shopifySync.kick();
  setTimeout(() => shopifySync.kick(), 8000); // a second pull in case the first ran before Shopify finished saving the order
});
app.all('/api/cron/sync', (req, res) => {
  if (!cronAuth(req, res)) return;
  const job = sync.syncIfDue('cron');
  if (req.query.wait !== '1') { // answer at once (pingers time out after ~30s); the sync carries on in the background
    job.then((r) => console.log('[cron] sync', r.skipped ? `skipped (${r.reason})` : r.changed === false ? 'ok, no changes' : 'ok, updated'))
       .catch((e) => console.warn('[cron] sync failed:', e.message));
    return res.status(202).json({ started: true });
  }
  job.then((r) => res.json({ ok: true, ...r, summary: undefined }))
     .catch((e) => res.status(e.status === 409 ? 202 : 500).json({ ok: false, error: e.message }));
});

// Shopify sends the store owner's browser back here after approving the app. No dashboard password is possible on this
// request, so it is protected by Shopify's signature, a single-use state value and a check that the store is ours.
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resultPage = (ok, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shopify</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1a1d21">
<h1 style="font-size:22px">${ok ? 'Shopify is connected' : 'Shopify could not be connected'}</h1><p>${escHtml(text)}</p>
<p><a href="/">${ok ? 'Back to the dashboard' : 'Back to the dashboard and try again'}</a></p></body>`;
app.get('/api/shopify/callback', async (req, res) => {
  try {
    const r = await require('./services/shopifyAuth').handleCallback(req.query);
    require('./services/shopifySync').kickFull();
    res.type('html').send(resultPage(true, `The store ${r.shop} is linked. Customer details and items are loading now; this can take a few minutes. You can close this tab.`));
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).type('html').send(resultPage(false, e.message));
  }
});

// Team logins (Confirm Queue, Dispatch Desk). These routes do their own per-person sign-in, so they sit before the shared-key gate.
const teamRoutes = require('./routes/flow');
app.use('/api/staff', teamRoutes.staff);
app.use('/api/flow', teamRoutes.flow);
app.use('/api/desk/stale-queue', require('./routes/staleQueue'));
app.use('/api/desk', require('./routes/desk'));

// Everything else under /api (the analytics dashboard) needs an admin signed in with their own login. There is no shared key.
app.use('/api', async (req, res, next) => {
  try {
    const u = await teamRoutes.staffFromReq(req);
    if (u && u.role === 'admin' && !u.mustChangePassword) return next();
  } catch (e) { /* fall through to 401 */ }
  res.status(401).json({ error: 'Sign in with your team login' });
});
app.use('/api', api);

// Serve the built React app in production
const dist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

mongoose.connect(cfg.mongoUri).then(() => {
  console.log('[db] connected');
  app.listen(cfg.port, () => console.log(`[server] http://localhost:${cfg.port}`));
  startAutoSync();
  require('./services/shopifySync').start();
  require('./services/shipwaySync').start();
  require('./services/deskService').start();
  require('./services/caseService').start();
}).catch((e) => { console.error('[db] connection failed:', e.message); process.exit(1); });
