/**
 * Lead FMS  <->  Google Sheet connector  (reads ALL tabs)
 * ------------------------------------------------------------------
 * The person who works on the sheet every morning types ONLY these columns:
 *     Timestamp | Lead Name | Lead Email | Lead Phone | UTW Date | Assigned To | Workshop Name
 * (Workshop Name = the workshop this lead came for. Type a NEW name and the website shows a filter for it.)
 * The website reads those rows from EVERY lead tab of this file (new leads appear for the callers).
 * When a caller updates a lead on the website, this script fills in:
 *     Level | Profession | City
 * on the same row, in whichever tab that lead is in.
 *
 * WHICH TABS ARE READ
 *  - Every tab that has a header row containing "Lead Phone" and "Lead Name" (columns can be in any order).
 *  - A tab whose name starts with an underscore (_Archive, _Notes ...) is IGNORED.
 *  - Hidden tabs and tabs without those headers are ignored.
 *  - To read just one tab, type its name in ONLY_TAB below.
 *
 * SETUP (once, ~3 minutes)
 *  1. In the Google Sheet:  Extensions -> Apps Script.  Delete what is there and paste this whole file.
 *  2. Press Save, then choose the function  setupSheet  and press Run (allow access when asked).
 *     It adds headers to empty tabs, greys out the three website columns, and keeps the Timestamp automatic.
 *  3. Deploy -> New deployment -> type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Press Deploy and copy the "Web app URL".
 *  4. In the website:  Settings -> Google Sheet -> paste that URL -> Save -> Test connection.
 *
 *  Adding a new tab later: right-click an existing tab -> Duplicate (keeps the headers), clear the old rows, rename it.
 *  A brand-new empty tab: run  setupSheet  once more. Not sure which tabs are read? Run  checkTabs.
 *  If you change this file later: Deploy -> Manage deployments -> edit -> New version.
 */

var SECRET_KEY = "__SECRET_KEY__";   // filled in for you by the website's "Copy Apps Script" button
var ONLY_TAB   = "";                 // leave empty = read every lead tab; or type one tab's name
var TIME_ZONE  = "Asia/Kolkata";

var WEBSITE_COLUMNS = ["Level", "Profession", "City"];
var TYPED_COLUMNS   = ["Workshop Name"];   // typed by the morning person; setupSheet adds the header when a tab has none
// the columns the website understands: [name sent to the website, how to recognise the header]
var COLUMNS = [
  ["Timestamp", /timestamp/], ["Lead Name", /^(?!.*workshop).*name/], ["Lead Email", /email/], ["Lead Phone", /phone/],
  ["UTW Date", /utw/], ["Assigned To", /assigned/], ["Workshop Name", /workshop/],
  ["Level", /^level/], ["Profession", /profession/], ["City", /city/]
];

/* ---------------------------------------------------------------- web app */

// the website asks: "give me all rows"
function doGet(e) {
  try {
    check_(e.parameter.token);
    return json_({ ok: true, rows: readRows_() });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// the website says: "write Level / Profession / City for these phone numbers"
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    check_(body.token);
    lock.waitLock(20000);
    return json_(Object.assign({ ok: true }, writeBack_(body.updates || [])));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function check_(token) {
  if (!SECRET_KEY || SECRET_KEY.indexOf("__") === 0) throw new Error("Secret key not set in the script");
  if (token !== SECRET_KEY) throw new Error("Wrong secret key");
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------- finding tabs */

function skipTab_(sh) {
  var name = sh.getName();
  return name.charAt(0) === "_" || sh.isSheetHidden() || (ONLY_TAB !== "" && name !== ONLY_TAB);
}

// a lead tab = a header row (within the first 15 rows) that has both "phone" and "name"
function inspect_(sh) {
  var rows = Math.min(sh.getLastRow(), 15), cols = sh.getLastColumn();
  if (rows < 1 || cols < 1) return null;
  var top = sh.getRange(1, 1, rows, cols).getValues();
  for (var i = 0; i < top.length; i++) {
    var head = top[i].map(function (h) { return String(h).trim().toLowerCase(); });
    if (head.some(function (h) { return /phone/.test(h); }) && head.some(function (h) { return /name/.test(h); })) {
      return { sheet: sh, hi: i, head: head };
    }
  }
  return null;
}

function leadTabs_() {
  var out = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (info) out.push(info);
  });
  return out;
}

function findCol_(head, re) {
  for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i;
  return -1;
}

// dates are sent as dd/MM/yyyy [HH:mm:ss] in India time, whatever the sheet's own locale is
function cell_(v) {
  if (v instanceof Date) {
    var midnight = Utilities.formatDate(v, TIME_ZONE, "HH:mm:ss") === "00:00:00";
    return Utilities.formatDate(v, TIME_ZONE, midnight ? "dd/MM/yyyy" : "dd/MM/yyyy HH:mm:ss");
  }
  return v === null || v === undefined ? "" : String(v);
}

/* ------------------------------------------------------------------- read */

// One combined table for the website: a fixed header + every lead row of every lead tab,
// re-ordered by header name so tabs may have their columns in a different order.
function readRows_() {
  var out = [COLUMNS.map(function (c) { return c[0]; })];
  leadTabs_().forEach(function (t) {
    var sh = t.sheet, last = sh.getLastRow();
    if (last <= t.hi + 1) return;
    var idx = COLUMNS.map(function (c) { return findCol_(t.head, c[1]); });
    var vals = sh.getRange(t.hi + 2, 1, last - t.hi - 1, sh.getLastColumn()).getValues();
    vals.forEach(function (r) {
      if (String(r[idx[3]]).trim() === "") return;                 // no phone = not a lead row
      out.push(idx.map(function (i) { return i < 0 ? "" : cell_(r[i]); }));
    });
  });
  return out;
}

/* ------------------------------------------------------------- write-back */

function last10_(v) { return String(v || "").replace(/\D/g, "").slice(-10); }

function writeBack_(updates) {
  var wanted = {};
  updates.forEach(function (u) { var p = last10_(u.phone); if (p) wanted[p] = u; });
  var found = {};

  leadTabs_().forEach(function (t) {
    var sh = t.sheet, last = sh.getLastRow(), head = t.head.slice();
    if (last <= t.hi + 1) return;
    var n = last - t.hi - 1, phoneCol = findCol_(head, /phone/);
    var phones = sh.getRange(t.hi + 2, phoneCol + 1, n, 1).getValues();

    // every row of this tab that holds one of the wanted numbers
    var rowsOf = {}, any = false;
    for (var i = 0; i < n; i++) {
      var p = last10_(phones[i][0]);
      if (p && wanted[p]) { (rowsOf[p] = rowsOf[p] || []).push(i); found[p] = true; any = true; }
    }
    if (!any) return;

    WEBSITE_COLUMNS.forEach(function (name) {
      var key = name.toLowerCase(), c = head.indexOf(key);
      if (c < 0) {                                                  // this tab has no such column yet: add it
        c = head.length; head.push(key);
        if (c + 1 > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
        sh.getRange(t.hi + 1, c + 1).setValue(name).setFontWeight("bold");
      }
      var range = sh.getRange(t.hi + 2, c + 1, n, 1), vals = range.getValues(), changed = false;
      Object.keys(rowsOf).forEach(function (p) {
        var v = wanted[p][key];
        if (v === undefined || v === null || String(v) === "") return;   // never blank out a cell
        rowsOf[p].forEach(function (ri) { if (String(vals[ri][0]) !== String(v)) { vals[ri][0] = v; changed = true; } });
      });
      if (changed) range.setValues(vals);
    });
  });

  SpreadsheetApp.flush();
  var missing = Object.keys(wanted).filter(function (p) { return !found[p]; });
  return { updated: Object.keys(found).length, missing: missing };
}

/* ------------------------------------------------------ one-time set-up */

var PROTECT_NOTE = "Filled by the website";

function prepareTab_(info) {
  var sh = info.sheet, hi = info.hi, head = info.head.slice();
  TYPED_COLUMNS.concat(WEBSITE_COLUMNS).forEach(function (name) {     // make sure Workshop Name / Level / Profession / City exist
    if (!head.some(function (h) { return h.indexOf(name.toLowerCase().split(" ")[0]) === 0 || h === name.toLowerCase(); })) {
      var c = head.length; head.push(name.toLowerCase());
      if (c + 1 > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(hi + 1, c + 1).setValue(name);
    }
  });
  sh.getRange(hi + 1, 1, 1, head.length).setFontWeight("bold");
  if (hi === 0) sh.setFrozenRows(1);

  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {   // re-running never stacks duplicates
    if (p.getDescription() === PROTECT_NOTE) p.remove();
  });
  WEBSITE_COLUMNS.forEach(function (name) {                           // grey + warn: these are filled by the website
    var c = head.indexOf(name.toLowerCase()) + 1, rows = Math.max(sh.getMaxRows() - hi, 2);
    sh.getRange(hi + 1, c, rows, 1).setBackground("#eef1f5");
    sh.getRange(hi + 1, c).setNote("Filled in automatically from the website. No need to type here.");
    sh.getRange(hi + 2, c, Math.max(rows - 1, 1), 1).protect().setDescription(PROTECT_NOTE).setWarningOnly(true);
  });
}

function setupSheet() {
  var done = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (!info) {
      if (sh.getDataRange().getValues().join("").trim() !== "") return;     // has other content: not a lead tab
      var hdr = COLUMNS.map(function (c) { return c[0]; });                 // empty tab -> write the headers
      sh.getRange(1, 1, 1, hdr.length).setValues([hdr]);
      info = inspect_(sh);
      if (!info) return;
    }
    prepareTab_(info);
    done.push(sh.getName());
  });
  SpreadsheetApp.getUi().alert(done.length
    ? "Done ✅  Set up these tabs: " + done.join(", ") + "\n\nNow deploy this script as a Web app (see the steps at the top of the file)."
    : "No lead tab found. A lead tab needs a header row with 'Lead Name' and 'Lead Phone'.");
}

// Shows which tabs the website will read and which are ignored (and why).
function checkTabs() {
  var read = [], skipped = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.charAt(0) === "_") return skipped.push(name + "  (starts with _)");
    if (sh.isSheetHidden()) return skipped.push(name + "  (hidden)");
    if (ONLY_TAB !== "" && name !== ONLY_TAB) return skipped.push(name + "  (ONLY_TAB is set)");
    var info = inspect_(sh);
    if (!info) return skipped.push(name + "  (no 'Lead Name' + 'Lead Phone' header row)");
    read.push(name + "  (" + Math.max(sh.getLastRow() - info.hi - 1, 0) + " rows)");
  });
  SpreadsheetApp.getUi().alert("READ by the website:\n" + (read.join("\n") || "none") + "\n\nIGNORED:\n" + (skipped.join("\n") || "none"));
}

/* ----------------------------------------------------------- timestamps */

// Fill the Timestamp of every row in r1..r2 that has a phone but no timestamp yet.
function stampRows_(sh, r1, r2, phoneCol, tsCol) {
  var n = r2 - r1 + 1;
  var phones = sh.getRange(r1, phoneCol, n, 1).getValues();
  var stamps = sh.getRange(r1, tsCol, n, 1);
  var vals = stamps.getValues(), now = new Date(), changed = false;
  for (var i = 0; i < n; i++) {
    if (String(phones[i][0]).trim() !== "" && String(vals[i][0]).trim() === "") { vals[i][0] = now; changed = true; }
  }
  if (changed) stamps.setValues(vals).setNumberFormat("dd/MM/yyyy HH:mm:ss");   // real dates: read correctly in any sheet locale
}

// Simple trigger (runs by itself): when Lead Phone is typed or pasted (one cell or many rows) in any lead tab,
// rows with a phone but an empty Timestamp get the current date and time.
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (!info) return;
    var phoneCol = findCol_(info.head, /phone/) + 1, tsCol = findCol_(info.head, /timestamp/) + 1;
    if (!phoneCol || !tsCol) return;
    var c1 = e.range.getColumn(), c2 = c1 + e.range.getNumColumns() - 1;
    if (phoneCol < c1 || phoneCol > c2) return;                       // the edit did not touch the phone column
    var r1 = Math.max(e.range.getRow(), info.hi + 2), r2 = e.range.getRow() + e.range.getNumRows() - 1;
    if (r2 >= r1) stampRows_(sh, r1, r2, phoneCol, tsCol);
  } catch (err) {}
}

// Run once by hand to stamp rows (in all lead tabs) that were added without a Timestamp.
function fillMissingTimestamps() {
  leadTabs_().forEach(function (t) {
    var last = t.sheet.getLastRow(), phoneCol = findCol_(t.head, /phone/) + 1, tsCol = findCol_(t.head, /timestamp/) + 1;
    if (last >= t.hi + 2 && phoneCol && tsCol) stampRows_(t.sheet, t.hi + 2, last, phoneCol, tsCol);
  });
  SpreadsheetApp.getUi().alert("Timestamps filled ✅");
}
