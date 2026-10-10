/**
 * Instant sync: tells the Order Analytics server the moment the sheet changes.
 *
 * Install (once, 2 minutes):
 *  1. Open the "Shopify New Order" sheet > Extensions > Apps Script.
 *  2. Paste this whole file, replace what is there. Fill in SERVER_URL and CRON_SECRET below, then Save.
 *  3. Pick the function  setup  in the toolbar and press Run. Approve the permissions when Google asks
 *     ("Advanced > Go to project" is normal for your own script).
 *  4. Done. Add a test row to the sheet: it should reach the dashboard within a few seconds.
 *
 * Needs the server's CRON_SECRET to be set (same value as below).
 */
const SERVER_URL = 'https://YOUR-SERVER.onrender.com'; // the server itself, not the Vercel address
const CRON_SECRET = 'PASTE_THE_SAME_SECRET_AS_ON_THE_SERVER';

// Runs on every change: new row, edit, paste, or a row added by Zapier / Make / Shopify connectors.
function notifyServer() {
  const opts = {
    method: 'post',
    headers: { 'x-cron-key': CRON_SECRET },
    muteHttpExceptions: true,
  };
  for (let i = 0; i < 3; i++) { // a sleeping server needs a moment to wake up
    try {
      const res = UrlFetchApp.fetch(SERVER_URL + '/api/webhook/sheet', opts);
      if (res.getResponseCode() < 300) return;
      if (res.getResponseCode() === 401) { console.error('CRON_SECRET does not match the server'); return; }
    } catch (e) { console.warn(e.message); }
    Utilities.sleep(5000);
  }
}

// Run this once. Creates the triggers (safe to run again: it removes the old ones first).
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (['notifyServer'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('notifyServer').forSpreadsheet(ss).onChange().create(); // instant
  ScriptApp.newTrigger('notifyServer').timeBased().everyMinutes(5).create();   // safety net + keeps a free host awake
  notifyServer();
}
