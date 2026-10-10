const fs = require('fs');
const { parse } = require('csv-parse/sync');
const cfg = require('../config');

const parseCsv = (text) => parse(text, { relax_column_count: true, skip_empty_lines: false, bom: true });

// Network calls must never hang (a hung sync would block every later one) and should survive Google blips.
async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (e.noRetry || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw err;
}
const TIMEOUT_MS = 45000;

async function fetchCsvUrl(url, label) {
  return withRetry(() => fetchCsvUrlOnce(url, label));
}

async function fetchCsvUrlOnce(url, label) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    const e = new Error(`Could not read "${label}" as CSV (HTTP ${res.status}). Share the sheet as "Anyone with the link can view", or set SHEET_SOURCE=api with a service account.`);
    if (res.status >= 400 && res.status < 500 && res.status !== 429) e.noRetry = true; // sharing problem: retrying will not help
    throw e;
  }
  return parseCsv(text);
}

function csvUrl(sc, tabName, gid) {
  const id = encodeURIComponent(sc.sheetId);
  return gid
    ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`
    : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tabName)}`;
}

async function accessToken(sc) {
  const { GoogleAuth } = require('google-auth-library');
  let credentials;
  if (sc.saJson) credentials = JSON.parse(sc.saJson);
  else if (sc.saFile) credentials = JSON.parse(fs.readFileSync(sc.saFile, 'utf8'));
  else throw new Error('SHEET_SOURCE=api needs GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function fetchApiRange(sc, token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sc.sheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  return withRetry(async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json();
    if (!res.ok) {
      const e = new Error(`Sheets API: ${body.error?.message || res.status} (range ${range})`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) e.noRetry = true;
      throw e;
    }
    return body.values || [];
  });
}

// Google silently returns the first tab when a tab name does not exist, so check we really got the Order Sheet.
function assertLooksLikeOrderSheet(rows) {
  const ok = (rows || []).slice(0, 5).some((r) => /order\s*id/i.test(String((r || [])[1] || '')));
  if (!ok) throw Object.assign(new Error('This tab does not look like the Order Sheet: no "Order ID" column in column B of the first rows. Open the Order Sheet tab, copy the link from the address bar, and save it again.'), { status: 400 });
}

// Returns { orderRows, masterRows|null, warnings }. Never writes to the sheet.
async function fetchSheets(sc) {
  const warnings = [];
  let orderRows, masterRows = null;
  if (sc.source === 'api') {
    const token = await accessToken(sc);
    orderRows = await fetchApiRange(sc, token, `'${sc.orderTab}'!A:O`);
    try { masterRows = await fetchApiRange(sc, token, `'${sc.masterTab}'!A:Z`); } catch (e) { warnings.push(`OrdersMaster not read: ${e.message}`); }
  } else {
    orderRows = await fetchCsvUrl(csvUrl(sc, sc.orderTab, sc.orderGid), sc.orderTab);
    try { masterRows = await fetchCsvUrl(csvUrl(sc, sc.masterTab, sc.masterGid), sc.masterTab); } catch (e) { warnings.push(`OrdersMaster not read: ${e.message}`); }
  }
  assertLooksLikeOrderSheet(orderRows);
  return { orderRows, masterRows, warnings };
}

module.exports = { fetchSheets, parseCsv, assertLooksLikeOrderSheet };
