const fs = require('fs');
const { parse } = require('csv-parse/sync');
const cfg = require('../config');

const parseCsv = (text) => parse(text, { relax_column_count: true, skip_empty_lines: false, bom: true });

async function fetchCsvUrl(url, label) {
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error(`Could not read "${label}" as CSV (HTTP ${res.status}). Share the sheet as "Anyone with the link can view", or set SHEET_SOURCE=api with a service account.`);
  }
  return parseCsv(text);
}

function csvUrl(tabName, gid) {
  const id = encodeURIComponent(cfg.sheet.id);
  return gid
    ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`
    : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tabName)}`;
}

async function accessToken() {
  const { GoogleAuth } = require('google-auth-library');
  let credentials;
  if (cfg.sheet.saJson) credentials = JSON.parse(cfg.sheet.saJson);
  else if (cfg.sheet.saFile) credentials = JSON.parse(fs.readFileSync(cfg.sheet.saFile, 'utf8'));
  else throw new Error('SHEET_SOURCE=api needs GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function fetchApiRange(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheet.id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Sheets API: ${body.error?.message || res.status} (range ${range})`);
  return body.values || [];
}

// Returns { orderRows, masterRows|null, warnings }. Never writes to the sheet.
async function fetchSheets() {
  const s = cfg.sheet;
  const warnings = [];
  if (s.source === 'none') throw new Error('Automatic fetch is off (SHEET_SOURCE=none). Upload CSV exports on the Settings page.');
  if (!s.id) throw new Error('SHEET_ID is not set');
  let orderRows, masterRows = null;
  if (s.source === 'api') {
    const token = await accessToken();
    orderRows = await fetchApiRange(token, `'${s.orderTab}'!A:O`);
    try { masterRows = await fetchApiRange(token, `'${s.masterTab}'!A:Z`); } catch (e) { warnings.push(`OrdersMaster not read: ${e.message}`); }
  } else {
    orderRows = await fetchCsvUrl(csvUrl(s.orderTab, s.orderGid), s.orderTab);
    try { masterRows = await fetchCsvUrl(csvUrl(s.masterTab, s.masterGid), s.masterTab); } catch (e) { warnings.push(`OrdersMaster not read: ${e.message}`); }
  }
  return { orderRows, masterRows, warnings };
}

module.exports = { fetchSheets, parseCsv };
