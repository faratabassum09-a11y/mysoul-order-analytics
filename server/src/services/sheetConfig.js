const cfg = require('../config');
const { Setting } = require('../models');

// Accepts a full Google Sheets link (or a bare ID). Returns the sheet ID and the tab gid found in the link.
function parseSheetLink(input) {
  const s = String(input || '').trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  const sheetId = m ? m[1] : /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
  if (!sheetId) throw Object.assign(new Error('That does not look like a Google Sheets link. Copy it from the browser address bar.'), { status: 400 });
  const g = /[#?&]gid=(\d+)/.exec(s);
  return { sheetId, gid: g ? g[1] : '' };
}

// Settings saved from the website win over environment variables.
async function getSheetConfig() {
  const saved = ((await Setting.findOne({ key: 'sheetConfig' }).lean()) || {}).value || {};
  const fromUi = !!saved.sheetId;
  const sheetId = saved.sheetId || cfg.sheet.id;
  let source = 'csv';
  if (!sheetId) source = 'none';
  else if (!fromUi && cfg.sheet.source === 'none') source = 'none';
  else if (cfg.sheet.source === 'api') source = 'api';
  return {
    sheetId, source, fromUi,
    orderTab: saved.orderTab || cfg.sheet.orderTab,
    masterTab: saved.masterTab || cfg.sheet.masterTab,
    orderGid: fromUi ? saved.orderGid || '' : cfg.sheet.orderGid,
    masterGid: fromUi ? saved.masterGid || '' : cfg.sheet.masterGid,
    saFile: cfg.sheet.saFile, saJson: cfg.sheet.saJson,
  };
}

async function saveSheetConfig(body) {
  const link = String(body.link || '').trim();
  const parsed = link ? parseSheetLink(link) : { sheetId: '', gid: '' };
  const value = {
    sheetId: parsed.sheetId,
    orderGid: parsed.gid,
    masterGid: String(body.masterGid || '').replace(/\D/g, ''),
    orderTab: String(body.orderTab || '').trim() || 'Order Sheet',
    masterTab: String(body.masterTab || '').trim() || 'OrdersMaster',
  };
  await Setting.findOneAndUpdate({ key: 'sheetConfig' }, { key: 'sheetConfig', value }, { upsert: true });
  return value;
}

module.exports = { parseSheetLink, getSheetConfig, saveSheetConfig };
