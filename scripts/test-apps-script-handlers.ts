// Runs the REAL apps-script/Code.gs against fakes of Google's services: the `notice` type, and a TEST monthly report going to its
// own workbook with every label saying TEST. Proves validation, escaping, and that a test can't touch the real workbook.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Mail = { to: string; subject: string; body: string; htmlBody?: string; name?: string; attachments?: unknown[] };
const sent: Mail[] = [];
const created: string[] = [];
const titles: string[] = [];
const pdfNames: string[] = [];

class Rng { values: unknown[][] = []; constructor(private sheet: Sheet, private r: number, private c: number) {}
  setValues(v: unknown[][]) { v.forEach((row, i) => (this.sheet.rows[this.r - 1 + i] = row)); return this; }
  getValues() { return this.sheet.rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? ""]); }
  getRange() { return this; }
}
class Sheet {
  rows: unknown[][] = [];
  constructor(public name: string) {}
  clear() { this.rows = []; } getName() { return this.name; } getSheetId() { return 7; } getLastRow() { return this.rows.length; }
  getRange(r: number, c: number) {
    const rng = new Rng(this, r, c);
    const self: unknown = new Proxy(rng, { get: (t, k: string) => (k in t ? (t as never)[k] : () => self) }); // every formatting call chains
    return self as never;
  }
  setColumnWidth() {} setHiddenGridlines() {} setFrozenRows() {} setFrozenColumns() {}
}
class Book {
  sheets: Sheet[] = []; constructor(public name: string) {}
  getSheets() { return this.sheets; } getSheetByName(n: string) { return this.sheets.find((s) => s.name === n) ?? null; }
  insertSheet(n: string, at?: number) { const s = new Sheet(n); if (at === 0) this.sheets.unshift(s); else this.sheets.push(s); return s; }
  deleteSheet(s: Sheet) { this.sheets = this.sheets.filter((x) => x !== s); } getUrl() { return `https://sheets.example/${this.name}`; } getId() { return this.name; }
}
const books = new Map<string, Book>();
const fakes = {
  MailApp: { sendEmail: (m: Mail) => sent.push(m) },
  SpreadsheetApp: { BorderStyle: { SOLID: 1 }, flush() {}, create: (name: string) => { created.push(name); const b = new Book(name); books.set(name, b); b.insertSheet("Sheet1"); return b; }, openById: (id: string) => books.get(id)! },
  DriveApp: {
    getRootFolder: () => ({
      getFilesByName: (name: string) => {
        const f = books.has(name) ? [{ getMimeType: () => "sheets", isTrashed: () => false, getId: () => name }] : [];
        let i = 0;
        return { hasNext: () => i < f.length, next: () => f[i++] };
      },
    }),
  },
  MimeType: { GOOGLE_SHEETS: "sheets" },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  ScriptApp: { getOAuthToken: () => "tok" },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName: (n: string) => { pdfNames.push(n); return { name: n }; } }) }) },
  Utilities: { formatDate: () => "September 2026" },
  Session: { getScriptTimeZone: () => "America/Denver" },
};
const src = readFileSync("apps-script/Code.gs", "utf8");
const names = Object.keys(fakes);
const api = new Function(...names, `${src}\nreturn { handleNotice_, handleMonthlyReport_, doPost };`)(...names.map((n) => (fakes as never)[n])) as { handleNotice_: (r: unknown) => unknown; handleMonthlyReport_: (r: unknown) => { ok: boolean }; doPost: (e: unknown) => { getContent?: () => string } };

// ---- notice
assert.deepEqual(api.handleNotice_({ to: ["a@b.co", "c@d.co"], subject: "Nudge", body: "12 to review" }), { ok: true });
assert.equal(sent.length, 1);
assert.equal(sent[0].to, "a@b.co,c@d.co");
assert.equal(sent[0].subject, "Nudge");
assert.equal(sent[0].body, "12 to review");
const evil = api.handleNotice_({ to: ["a@b.co"], subject: "Hi\r\nBcc: x@y.z", body: "<script>alert(1)</script> & more" });
assert.deepEqual(evil, { ok: true });
assert.ok(!/[\r\n]/.test(sent[1].subject), "a subject can't smuggle a header line");
assert.ok(!sent[1].htmlBody!.includes("<script>") && sent[1].htmlBody!.includes("&lt;script&gt;"), "the body is escaped, never HTML");
for (const bad of [
  { to: [], subject: "s", body: "b" }, { to: ["not-an-email"], subject: "s", body: "b" }, { to: Array(11).fill("a@b.co"), subject: "s", body: "b" },
  { to: ["a@b.co"], subject: "", body: "b" }, { to: ["a@b.co"], subject: "x".repeat(151), body: "b" }, { to: ["a@b.co"], subject: "s", body: "" }, { to: ["a@b.co"], subject: "s", body: "x".repeat(5001) }, { to: "a@b.co", subject: "s", body: "b" },
]) assert.throws(() => api.handleNotice_(bad), /invalid/, JSON.stringify(bad).slice(0, 60));
assert.equal(sent.length, 2, "nothing was sent for a rejected request");

// ---- TEST monthly report
const payload = (test?: boolean) => ({ year: 2026, month: 9, businessName: "Yummy", sections: [{ key: "REVENUE", label: "Revenue", subtotalLabel: "Gross Revenue", subtotalCents: 1000 }], lines: [{ section: "REVENUE", label: "Total Revenue/Sales", cents: 1000 }], netCents: 1000, cashNotes: [], warnings: [], recipients: ["owner@x.com"], ...(test === undefined ? {} : { test }) });
assert.deepEqual(api.handleMonthlyReport_(payload(true)), { ok: true, sheetUrl: "https://sheets.example/Yummy Finances TEST 2026#gid=7" });
assert.deepEqual(created, ["Yummy Finances TEST 2026"], "a TEST goes to its own workbook");
const testBook = books.get("Yummy Finances TEST 2026")!;
const titleRow = String(testBook.getSheetByName("2026-09")!.rows[0][0]);
titles.push(titleRow);
assert.match(titleRow, /^TEST - NOT A REAL REPORT - Yummy/);
assert.deepEqual(pdfNames, ["TEST Yummy P&L 2026-09.pdf"]);
const testMail = sent.at(-1)!;
assert.match(testMail.subject, /^\[TEST\] Yummy P&L/);
assert.match(testMail.body, /^TEST - not the real report/);
assert.match(testMail.htmlBody!, /<b>TEST\.<\/b> This is a test copy/);
assert.equal(testMail.to, "owner@x.com");

// the real one is untouched by the test, and carries no TEST label
api.handleMonthlyReport_(payload());
assert.deepEqual(created, ["Yummy Finances TEST 2026", "Yummy Finances 2026"], "the real workbook is a different file");
const real = books.get("Yummy Finances 2026")!;
assert.ok(!/TEST/.test(String(real.getSheetByName("2026-09")!.rows[0][0])));
assert.ok(!/TEST/.test(sent.at(-1)!.subject) && !/TEST/.test(String(sent.at(-1)!.htmlBody)));
assert.equal(pdfNames.at(-1), "Yummy P&L 2026-09.pdf");
api.handleMonthlyReport_(payload(false));
assert.equal(created.length, 2, "test:false is a real report");
// only an explicit boolean true is a test: a string can't turn the test label on or off by accident
api.handleMonthlyReport_(payload("true" as never));
assert.equal(created.length, 2);
assert.ok(!/TEST/.test(sent.at(-1)!.subject));

// ---- routing: an unknown type is still refused
console.log("apps-script handlers: all checks passed");
