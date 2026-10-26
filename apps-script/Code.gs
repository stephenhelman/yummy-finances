/**
 * Yummy Finances mailer + report sheet. Deploy as a Web app:
 *   Execute as: Me    Who has access: Anyone
 * Script properties (Project Settings > Script properties):
 *   APPS_SCRIPT_SECRET  shared secret, must equal the app's APPS_SCRIPT_SECRET (required)
 *   DRIVE_FOLDER_ID     Drive folder that holds the yearly workbooks (optional; defaults to My Drive)
 *
 * Every request is a JSON POST: { secret, type, ...fields }. Every response is JSON: { ok, error? }.
 * Nothing here logs the secret or request bodies.
 */

var BRAND = 'Yummy Finances';
var MONTH_TAB_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
var SECTION_ORDER = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
var EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function doPost(e) {
  try {
    var req = parseRequest_(e);
    if (!req) return json_({ ok: false, error: 'unauthorized' });
    switch (req.type) {
      case 'ping': return json_({ ok: true });
      case 'login_email': return json_(handleLoginEmail_(req));
      case 'monthly_report': return json_(handleMonthlyReport_(req));
      default: return json_({ ok: false, error: 'unknown type' });
    }
  } catch (err) {
    // Message only: never the request body.
    return json_({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
}

function doGet() {
  return json_({ ok: false, error: 'POST only' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Returns the parsed body, or null for anything that is not a well-formed, correctly-signed request. */
function parseRequest_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty('APPS_SCRIPT_SECRET');
  if (!expected || !e || !e.postData || !e.postData.contents) return null;
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return null; }
  if (!body || typeof body !== 'object' || typeof body.secret !== 'string' || typeof body.type !== 'string') return null;
  if (!safeEqual_(body.secret, expected)) return null;
  return body;
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money_(n) { return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// ---------------------------------------------------------------- login_email

function handleLoginEmail_(req) {
  if (typeof req.to !== 'string' || !EMAIL_RE.test(req.to)) throw new Error('invalid to');
  if (typeof req.link !== 'string' || !/^https?:\/\//.test(req.link)) throw new Error('invalid link');
  var mins = Number(req.expiresMinutes);
  if (!(mins > 0 && mins <= 1440)) throw new Error('invalid expiresMinutes');
  var html =
    '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">' +
    '<h2 style="margin:0 0 16px;color:#b3265f">' + BRAND + '</h2>' +
    '<p>Click the button to sign in. The link works once and expires in ' + mins + ' minutes.</p>' +
    '<p style="margin:24px 0"><a href="' + esc_(req.link) + '" style="background:#b3265f;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Sign in</a></p>' +
    '<p style="font-size:12px;color:#777">If you did not ask for this, ignore this email.</p></div>';
  MailApp.sendEmail({
    to: req.to,
    subject: 'Your ' + BRAND + ' sign-in link',
    htmlBody: html,
    body: 'Sign in to ' + BRAND + ' (single use, expires in ' + mins + ' minutes): ' + req.link,
    name: BRAND,
  });
  return { ok: true };
}

// ------------------------------------------------------------- monthly_report

/**
 * Payload (amounts are integer cents):
 *  sections: [{key:'REVENUE'|'COGS'|'OPEX'|'OTHER', label, subtotalCents}]
 *  lines:    [{section, label, cents}]
 *  netCents (optional), cashNotes: string[], warnings: string[], recipients: string[]
 */
function handleMonthlyReport_(req) {
  var year = Number(req.year), month = Number(req.month);
  if (!(year >= 2000 && year <= 2100 && month >= 1 && month <= 12) || year % 1 || month % 1) throw new Error('invalid year/month');
  if (!Array.isArray(req.sections) || !Array.isArray(req.lines)) throw new Error('invalid sections/lines');
  var recipients = Array.isArray(req.recipients) ? req.recipients : [];
  if (!recipients.length || recipients.length > 10 || !recipients.every(function (r) { return typeof r === 'string' && EMAIL_RE.test(r); })) throw new Error('invalid recipients');
  var tab = year + '-' + (month < 10 ? '0' : '') + month;
  var business = String(req.businessName || BRAND);
  var warnings = (req.warnings || []).map(String);
  var cashNotes = (req.cashNotes || []).map(String);

  var ss = getOrCreateWorkbook_(year);
  var sheet = writeMonthTab_(ss, tab, business, req, warnings, cashNotes);
  rebuildYtd_(ss);
  SpreadsheetApp.flush();

  var pdf = exportTabPdf_(ss, sheet, business + ' P&L ' + tab + '.pdf');
  var url = ss.getUrl();
  var monthName = Utilities.formatDate(new Date(year, month - 1, 1), Session.getScriptTimeZone(), 'MMMM yyyy');
  var html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222">' +
    '<h2 style="margin:0 0 16px;color:#b3265f">' + esc_(business) + '</h2>' +
    '<p>The profit &amp; loss report for <b>' + esc_(monthName) + '</b> is attached as a PDF.</p>' +
    (warnings.length ? '<p style="color:#a15c00"><b>' + warnings.length + ' warning(s)</b> are listed at the top of the report.</p>' : '') +
    '<p><a href="' + esc_(url) + '">Open the ' + year + ' workbook</a></p></div>';
  MailApp.sendEmail({
    to: recipients.join(','),
    subject: business + ' P&L, ' + monthName,
    htmlBody: html,
    body: 'The P&L for ' + monthName + ' is attached. Workbook: ' + url,
    name: BRAND,
    attachments: [pdf],
  });
  return { ok: true, sheetUrl: url + '#gid=' + sheet.getSheetId() };
}

function getOrCreateWorkbook_(year) {
  var name = 'Yummy Finances ' + year;
  var folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  var files = folder.getFilesByName(name);
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) return SpreadsheetApp.openById(f.getId());
  }
  var ss = SpreadsheetApp.create(name);
  if (folderId) DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

/** Creates or fully rewrites the tab for this month (same gid, so re-sending never duplicates). */
function writeMonthTab_(ss, tab, business, req, warnings, cashNotes) {
  var sheet = ss.getSheetByName(tab);
  if (sheet) { sheet.clear(); } else { sheet = ss.insertSheet(tab); }
  var rows = []; // [A label, B amount|'', C key]
  var fmt = [];  // {row, kind}
  function push(label, amount, key, kind) { rows.push([label, amount, key || '']); fmt.push(kind || 'line'); }

  push(business + ' — Profit & Loss — ' + tab, '', '', 'title');
  if (warnings.length) {
    push('Warnings', '', '', 'warnhead');
    warnings.forEach(function (w) { push(w, '', '', 'warn'); });
    push('', '', '', 'blank');
  }
  var byKey = {};
  req.lines.forEach(function (l) { (byKey[l.section] = byKey[l.section] || []).push(l); });
  var seen = {};
  req.sections.forEach(function (s) { seen[s.key] = s; });
  var ordered = SECTION_ORDER.filter(function (k) { return seen[k]; });
  Object.keys(seen).forEach(function (k) { if (ordered.indexOf(k) < 0) ordered.push(k); });
  ordered.forEach(function (k) {
    var s = seen[k];
    push(String(s.label || k), '', '', 'section');
    (byKey[k] || []).forEach(function (l) { push('   ' + String(l.label), Number(l.cents) / 100, 'L|' + k + '|' + l.label, 'line'); });
    push('Total ' + String(s.label || k), Number(s.subtotalCents) / 100, 'S|' + k, 'subtotal');
    push('', '', '', 'blank');
  });
  if (req.netCents !== undefined && req.netCents !== null) push('Net income', Number(req.netCents) / 100, 'N', 'net');
  if (cashNotes.length) {
    push('', '', '', 'blank');
    push('Cash notes', '', '', 'section');
    cashNotes.forEach(function (n) { push(n, '', '', 'note'); });
  }

  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange(1, 2, rows.length, 1).setNumberFormat('$#,##0.00;-$#,##0.00');
  sheet.setColumnWidth(1, 360); sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 20);
  sheet.getRange(1, 3, rows.length, 1).setFontColor('#ffffff'); // row keys, used to rebuild YTD
  fmt.forEach(function (kind, i) {
    var r = sheet.getRange(i + 1, 1, 1, 2);
    if (kind === 'title') r.setFontWeight('bold').setFontSize(14);
    else if (kind === 'warnhead') r.setFontWeight('bold').setFontColor('#a15c00');
    else if (kind === 'warn') sheet.getRange(i + 1, 1).setFontColor('#a15c00');
    else if (kind === 'section') r.setFontWeight('bold').setBackground('#f4e3ea');
    else if (kind === 'subtotal') r.setFontWeight('bold').setBorder(true, null, null, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
    else if (kind === 'net') r.setFontWeight('bold').setBackground('#e6e6e6');
  });
  sheet.setHiddenGridlines(true);
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  return sheet;
}

/** Rebuilds "YTD Summary" from the month tabs: one column per month present, plus a total. */
function rebuildYtd_(ss) {
  var months = ss.getSheets().map(function (s) { return s.getName(); }).filter(function (n) { return MONTH_TAB_RE.test(n); }).sort();
  var ytd = ss.getSheetByName('YTD Summary') || ss.insertSheet('YTD Summary', 0);
  ytd.clear();
  if (!months.length) return;

  var data = {};       // month -> key -> amount
  var labels = {};     // key -> label
  var order = {};      // section -> [line keys in first-seen order]
  var hasNet = false;
  months.forEach(function (m) {
    var sh = ss.getSheetByName(m);
    var vals = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
    data[m] = {};
    vals.forEach(function (r) {
      var key = String(r[2]);
      if (!key) return;
      data[m][key] = r[1];
      if (key === 'N') hasNet = true;
      var parts = key.split('|');
      if (parts[0] === 'L') {
        labels[key] = String(r[0]).replace(/^\s+/, '');
        var list = (order[parts[1]] = order[parts[1]] || []);
        if (list.indexOf(key) < 0) list.push(key);
      } else if (parts[0] === 'S') {
        labels[key] = String(r[0]);
      }
    });
  });

  var sections = SECTION_ORDER.filter(function (k) { return labels['S|' + k]; });
  Object.keys(labels).forEach(function (key) {
    var p = key.split('|');
    if (p[0] === 'S' && sections.indexOf(p[1]) < 0) sections.push(p[1]);
  });

  var header = ['Yummy Finances YTD'].concat(months, ['Total']);
  var out = [header], kinds = ['header'];
  function addRow(label, key, kind) {
    var row = [label], sum = 0;
    months.forEach(function (m) { var v = data[m][key]; row.push(v === undefined ? '' : v); if (typeof v === 'number') sum += v; });
    row.push(sum);
    out.push(row); kinds.push(kind);
  }
  sections.forEach(function (k) {
    var sectionLabel = labels['S|' + k].replace(/^Total /, '');
    out.push([sectionLabel].concat(months.map(function () { return ''; }), [''])); kinds.push('section');
    (order[k] || []).forEach(function (key) { addRow('   ' + labels[key], key, 'line'); });
    addRow(labels['S|' + k], 'S|' + k, 'subtotal');
  });
  if (hasNet) addRow('Net income', 'N', 'net');

  var width = header.length;
  ytd.getRange(1, 1, out.length, width).setValues(out);
  ytd.getRange(2, 2, out.length - 1, width - 1).setNumberFormat('$#,##0.00;-$#,##0.00');
  ytd.setColumnWidth(1, 300);
  kinds.forEach(function (kind, i) {
    var r = ytd.getRange(i + 1, 1, 1, width);
    if (kind === 'header') r.setFontWeight('bold').setBackground('#b3265f').setFontColor('#ffffff');
    else if (kind === 'section') r.setFontWeight('bold').setBackground('#f4e3ea');
    else if (kind === 'subtotal') r.setFontWeight('bold').setBorder(true, null, null, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
    else if (kind === 'net') r.setFontWeight('bold').setBackground('#e6e6e6');
  });
  ytd.getRange(1, width, out.length, 1).setFontWeight('bold');
  ytd.setFrozenRows(1); ytd.setFrozenColumns(1);
}

function exportTabPdf_(ss, sheet, filename) {
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?' + [
    'format=pdf', 'gid=' + sheet.getSheetId(), 'portrait=true', 'size=letter', 'fitw=true',
    'gridlines=false', 'sheetnames=false', 'printtitle=false', 'pagenumbers=false',
    'range=' + encodeURIComponent('A1:B' + sheet.getLastRow()),
  ].join('&');
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('PDF export failed (' + res.getResponseCode() + ')');
  return res.getBlob().setName(filename);
}
