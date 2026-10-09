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
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.get('/api/auth/required', (req, res) => res.json({ required: !!cfg.accessPassword }));

// Optional shared-password gate for everything else under /api
app.use('/api', (req, res, next) => {
  if (!cfg.accessPassword) return next();
  if (req.get('x-access-key') === cfg.accessPassword) return next();
  res.status(401).json({ error: 'Access key required' });
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
}).catch((e) => { console.error('[db] connection failed:', e.message); process.exit(1); });
