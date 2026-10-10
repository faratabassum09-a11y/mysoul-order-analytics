require('dotenv').config();
const env = process.env;
module.exports = {
  port: Number(env.PORT) || 4000,
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/mysoul_orders',
  accessPassword: env.ACCESS_PASSWORD || '',
  sheet: {
    id: env.SHEET_ID || '',
    orderTab: env.SHEET_ORDER_TAB || 'Order Sheet',
    masterTab: env.SHEET_MASTER_TAB || 'OrdersMaster',
    source: (env.SHEET_SOURCE || 'csv').toLowerCase(),
    orderGid: env.SHEET_ORDER_GID || '',
    masterGid: env.SHEET_MASTER_GID || '',
    saFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    saJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  },
  // Auto-sync is ON by default (every 15 min). Set SYNC_INTERVAL_MIN=0 to turn it off.
  syncIntervalMin: env.SYNC_INTERVAL_MIN === undefined || env.SYNC_INTERVAL_MIN === '' ? 15 : Math.max(0, Number(env.SYNC_INTERVAL_MIN) || 0),
  // Secret for the external trigger URL /api/cron/sync (cron-job.org, UptimeRobot, GitHub Actions).
  cronSecret: env.CRON_SECRET || '',
  cronMinAgeMin: Number(env.CRON_MIN_AGE_MIN) || 5,
};
