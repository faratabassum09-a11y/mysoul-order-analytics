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
  // Shopify Admin API (Dev Dashboard app, client-credentials grant). Secrets live in the host's environment only.
  shopify: {
    // Store subdomain only: for https://my-store.myshopify.com use "my-store". Pasting the full address also works.
    shop: (env.SHOPIFY_SHOP || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/.*$/, ''),
    clientId: (env.SHOPIFY_CLIENT_ID || '').trim(),
    clientSecret: (env.SHOPIFY_CLIENT_SECRET || '').trim(),
    apiVersion: (env.SHOPIFY_API_VERSION || '2026-04').trim(),
    // Permissions asked for when linking the store (install link flow). Add read_all_orders once Shopify has approved it.
    scopes: (env.SHOPIFY_SCOPES || 'read_orders,read_customers').replace(/\s+/g, ''),
    // Shopify hands out expiring tokens (renewed automatically). Set to 0 only if Shopify rejects them for your app.
    expiringTokens: env.SHOPIFY_EXPIRING_TOKENS !== '0',
    // How often to pull new and changed orders (0 = only after sheet changes and by button).
    syncIntervalMin: env.SHOPIFY_SYNC_INTERVAL_MIN === undefined || env.SHOPIFY_SYNC_INTERVAL_MIN === '' ? 2 : Math.max(0, Number(env.SHOPIFY_SYNC_INTERVAL_MIN) || 0),
  },
  // Public address of this server (used for the Shopify redirect URL). Render sets RENDER_EXTERNAL_URL by itself.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').trim(),
  // Secret for the external trigger URL /api/cron/sync (cron-job.org, UptimeRobot, GitHub Actions).
  cronSecret: env.CRON_SECRET || '',
  cronMinAgeMin: Number(env.CRON_MIN_AGE_MIN) || 5,
};
