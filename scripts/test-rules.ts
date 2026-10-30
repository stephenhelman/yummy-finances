import assert from "node:assert/strict";
import { classify, ruleMatches, sortRules } from "../src/lib/rules/engine";
import { mergeTruncatedKeys, normalizeDescriptor as norm } from "../src/lib/rules/normalize";
import { matchPairs } from "../src/lib/rules/pairs";
import { SEED_RULES, OWNER_DECISION_RULE_IDS, ADDITION_RULE_IDS } from "../src/lib/rules/seed";
import { USER_RULES } from "../src/lib/rules/user-rules";
import { ALL_RULES } from "../src/lib/rules/all";
import { CAT, PLANNED_CATEGORY_CHANGES, applyPlannedCategoryChanges } from "../src/lib/rules/categories";
import { CASH_NOTES, cashNotesFor } from "../src/lib/rules/cash-notes";
import { CHECK_PICKS, ZELLE_PICKS, quickPicksFor } from "../src/lib/rules/review";
import { cadenceOf, extractZelleCounterparty, recipientKey, summarizeRecipients, zelleRecipientRules } from "../src/lib/rules/zelle";
import { KIND_DIRECTIONS, KINDS, PNL_KINDS, validateRule, type RuleDef, type TxnInput } from "../src/lib/rules/types";

// ---- accounts and a tiny builder ---------------------------------------------------------------
const BOA2879 = { id: "a2879", institution: "Bank of America", mask: "2879", type: "depository" };
const BOA9334 = { id: "a9334", institution: "Bank of America", mask: "9334", type: "depository" };
const CHASE = { id: "c6318", institution: "Chase", mask: "6318", type: "credit" };
let n = 0;
const tx = (raw: string, cents: number, account = BOA2879, date = "2026-06-10", extra: Partial<TxnInput> = {}): TxnInput => ({ id: `t${++n}`, date, amountCents: cents, raw, account, ...extra });
const one = (t: TxnInput, rules: RuleDef[] = SEED_RULES) => classify([t], rules, { pairs: false })[0];

// ===== 1. normalizer, from real descriptors (digits changed, shapes kept) =============================
{
  // all Sam's Club variants -> one key
  const sams = [
    "CHECKCARD 1109 SAMSCLUB.COM XXXXX67726 AR XXXXX8253XXXXXXXXXX1234 CKCD 5300 XXXXXXXXXX123456",
    "CHECKCARD 0903 SAMS CLUB.COM BENTONVILLE AR CKCD 5300 XXXXXXXXXX123456",
    "CHECKCARD 1018 SAMS CLUB #650 EL PASO TX CKCD 5300 XXXXXXXXXX123456",
    "CHECKCARD 0208 SAMSCLUB #8280 EL PASO TX XXXXX0160XXXXXXXXXX1234 CKCD 5300 XXXXXXXXXX123456",
    "SAMSCLUB.COM",
    "SAMS CLUB #6502",
    "SAMS CLUB.COM",
    "SAMSCLUB #8280 04/10 #XXXXX8500 PURCHASE 11360 PELLICANO EL PASO TX CKCD 5300 XXXXXXXXXX123456",
  ];
  assert.deepEqual([...new Set(sams.map(norm))], ["SAMS CLUB"]);

  const same = (key: string, raws: string[]) => assert.deepEqual([...new Set(raws.map(norm))], [key], key);
  same("WALMART", ["CHECKCARD 1125 Walmart.com Bentonville AR CKCD 5310 XXXXXXXXXX123456", "WALMART.COM", "WAL-MART #1234 10/12 #XXXXX9999 PURCHASE 9999 N ZARAGOZA R EL PASO TX CKCD 5411", "Walmart.com 10/12 #XXXXX1234 REFUND Walmart.com Bentonville AR CKCD 5311"]);
  same("HOME DEPOT", ["THE HOME DEPOT 10/02 #XXXXX2114 PURCHASE 12221 MONTWOOD DR EL PASO TX CKCD 5200", "MOBILE PURCHASE 0904 THE HOME DEPOT #9 EL PASO TX XXXXX9999XXXXXXXXXX9999 CKCD 5200", "THE HOME DEPOT #1234", "THE HOME DEPOT 10/02 #XXXXX2114 REFUND 12221 MONTWOOD DR EL PASO TX"]);
  same("TARGET", ["TARGET T-2216 11/08 #XXXXX9530 PURCHASE TARGET T-2216 El Paso TX CKCD 5310", "CHECKCARD 0210 TARGET.COM * XXXXX99999 MN XXXXX9999XXXXXXXXXX9999 CKCD 5310"]);
  same("ECONOMY CASH AND CARRY", ["ECONOMY CASH A 11/04 #XXXXX4300 PURCHASE 411 N ZARAGOZA EL PASO TX CKCD 5300", "CHECKCARD 1015 ECONOMY CASH AND EL PASO TX XXXXX9999XXXXXXXXXX9999 CKCD 5300", "ECONOMY CASH AND CARRY I"]);
  same("RESTAURANT DEPOT", ["RESTAURANT DEP 10/13 #XXXXX3165 MOBILE PURCHASE RESTAURANT DEPOT EL PASO TX CKCD 5300", "RESTAURANT DEPOT", "RESTAURANT DEP 10/06 #XXXXX1329 REFUND RESTAURANT DEPOT EL PASO TX"]);
  same("CORTEZ WHOLESALE", ["CORTEZ WHOLESA 10/13 #XXXXX0433 PURCHASE 111 N PIEDRAS STR EL PASO TX CKCD 5300", "OMO CORTEZ WHO 10/13 #XXXXX0433 PURCHASE 111 N PIEDRAS STR EL PASO TX", "CORTEZ WHOLESALE INC"]);
  same("WEBSTAURANT STORE", ["CHECKCARD 1013 THE WEBSTAURANT S XXXXX27472 PA XXXXX9062XXXXXXXXXX1234 CKCD 5300", "PURCHASE 1012 THE WEBSTAURANT S XXXXX27472 PA XXXXX9062XXXXXXXXXX1234 CKCD 5300", "THE WEBSTAURANT STORE INC"]);
  same("EL PASO ELECTRIC", ["B2P*EL PASO ELECTRIC", "CHECKCARD 0511 B2P*EL PASO ELECT XXXXX21634 TX XXXXX8461XXXXXXXXXX1234 CKCD 4900"]);
  same("EL PASO WATER", ["EL PASO WATER UTILITIES", "CHECKCARD 0903 EL PASO WATER UTI XXXXX99999 TX XXXXX9999XXXXXXXXXX9999 CKCD 4900", "CHECKCARD 0903 EL PASO WATER El Paso TX CKCD 4900 XXXXXXXXXX123456"]);
  same("CREAMLAND", ["CREAMLAND", "CHECKCARD 0903 CREAMLAND XXXXX99999 NM XXXXX9999XXXXXXXXXX9999 CKCD 5300"]);

  // ACH: originator + a readable type; ids, masks and uuid-like types are noise
  assert.equal(norm("CLOVER FEES DES:CLOVER FEE ID:1187264 INDN:LA MICHOACANA YUMMY CO ID:XXXXX99999 CCD"), "CLOVER FEES");
  assert.equal(norm("CLOVER APP DES:CLOVER APP ID:1187264 INDN:LA MICHOACANA YUMMY CO ID:XXXXX99999 PPD"), "CLOVER APP");
  assert.equal(norm("BANKCARD-1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SD CCD"), "BANKCARD MTOT DEP");
  assert.equal(norm("BANKCARD 1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SD CCD"), "BANKCARD MTOT DEP", "dash and space variants agree");
  assert.equal(norm("BANKCARD-1250 DES:MTOT DISC ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SM CCD"), "BANKCARD MTOT DISC");
  assert.equal(norm("DAVO TECHNOLOGIE DES:ACH ID:888-659-8432 INDN:LA MICHOACANA YUMMY LA CO ID:XXXXX12345 PPD"), "DAVO TECHNOLOGIE");
  assert.equal(norm("DAVO TECHNOLOGIE DES:40AF0774-8 ID:888-659-8432 INDN:LA MICHOACANA YUMMY LA CO ID:XXXXX12345 PPD"), "DAVO TECHNOLOGIE", "uuid-like types dropped");
  assert.equal(norm("FirstLight FCU DES:ACH ORGTN ID:XXXXXXXXXX88468 INDN:SOMEONE,NAME CO ID:XXXXX99999 PPD"), "FIRSTLIGHT FCU ORGTN");
  assert.equal(norm("CHASE CREDIT CRD DES:EPAY ID:XXXXX02639 INDN:CARD HOLDER CO ID:XXXXX99999 WEB"), "CHASE CREDIT CRD EPAY");
  assert.equal(norm("Payroll-Homebase DES:PCR ID:dbfdcfb9a99c99e INDN:La Michoacana Yummy LL CO ID:XXXXX99999 CCD"), "PAYROLL HOMEBASE PCR");
  assert.equal(norm("Payroll-Homebase DES:RFD ID:8c7e5b2146d9439 INDN:La Michoacana Yummy LL CO ID:XXXXX99999 CCD"), "PAYROLL HOMEBASE RFD");

  // account numbers after CHK/SAV survive (they say WHICH account); confirmation numbers do not
  assert.equal(norm("Online Banking transfer to CHK 3831 Confirmation# XXXXX6"), "ONLINE BANKING TRANSFER TO CHK 3831");
  assert.equal(norm("Online Banking transfer from CHK 2879 Confirmation# XXXXX8696"), "ONLINE BANKING TRANSFER FROM CHK 2879");
  assert.equal(norm("Online Banking transfer to SAV 2870 Confirmation# XXXXX85782"), "ONLINE BANKING TRANSFER TO SAV 2870");

  // bank branch / ATM rows keep deposit vs withdrawal
  assert.equal(norm("BKOFAMERICA ATM 10/26 #XXXXX2228 DEPOSIT JOE BATTLE EL PASO TX CKCD XXXXXXXXXX123456"), "BKOFAMERICA ATM DEPOSIT");
  assert.equal(norm("BKOFAMERICA ATM 11/14 #XXXXX2581 WITHDRWL EDGEMERE AND TIERRA EL PASO TX CKCD XXXXXXXXXX123456"), "BKOFAMERICA ATM WITHDRWL");
  assert.equal(norm("BKOFAMERICA BC 11/10 #XXXXX3088 WITHDRWL 1810 N Zaragoza R El Paso TX"), "BKOFAMERICA BC WITHDRWL");
  assert.equal(norm("BKOFAMERICA MOBILE 11/29 XXXXX07337 DEPOSIT *MOBILE TX"), "BKOFAMERICA MOBILE DEPOSIT");
  assert.equal(norm("Counter Credit"), "COUNTER CREDIT");
  assert.equal(norm("Check 169"), "CHECK");
  assert.equal(norm("Check 1391"), "CHECK");

  // processor prefixes, star references, memos, city/state, dates
  assert.equal(norm("CHECKCARD 1006 SQ *S. J. MEXICAN El Paso TX XXXXX8662XXXXXXXXXX1234 CKCD 5812"), "S J MEXICAN");
  assert.equal(norm("PURCHASE 1020 Audible*W77U70KS3 XXXXX35051 NJ XXXXX8660XXXXXXXXXX1234 CKCD 5968"), "AUDIBLE");
  assert.equal(norm("GOOGLE *YouTube TV"), "GOOGLE YOUTUBE TV");
  assert.equal(norm("MOBILE PURCHASE 0402 LA ESTRELLA EL PASO TX XXXXX1460XXXXXXXXXX1234 CKCD 5812"), "LA ESTRELLA", "'LA' only trims as a TRAILING state");
  assert.equal(norm("PURCHASE INTEREST CHARGE"), "INTEREST CHARGE");
  assert.equal(norm("Payment Thank You-Mobile"), "PAYMENT THANK YOU MOBILE");
  assert.equal(norm("Payment Thank You - Web"), "PAYMENT THANK YOU WEB");
  assert.equal(norm("Zelle payment to MIGUEL LOPEZ Conf# wrwwdn4fc"), "ZELLE PAYMENT TO MIGUEL LOPEZ", "names kept: they decide the rule");
  assert.equal(norm('Zelle Scheduled payment to Mom for "Sams"; Conf# un15hjj'), "ZELLE SCHEDULED PAYMENT TO MOM");
  assert.equal(norm("PMNT SENT 1119 CASH APP*LIZETH C XXXXX91940 CA XXXXX5553"), "CASH APP LIZETH C");
  assert.equal(norm("CHECKCARD 0127 TACO CABANA 20297 EL PASO TX XXXXX5261XXXXXXXXXX1234 CKCD 5814"), "TACO CABANA");
  assert.equal(norm("   "), "(BLANK)");
  assert.equal(norm(""), "(BLANK)");

  // idempotent: normalizing a key gives the key back
  for (const raw of [...sams, "CLOVER FEES DES:CLOVER FEE ID:1 INDN:X", "Online Banking transfer to CHK 3831 Confirmation# XXXXX6", "BKOFAMERICA ATM 10/26 #XXXXX2228 DEPOSIT JOE BATTLE EL PASO TX", "Zelle payment to MIGUEL LOPEZ Conf# x", "BANKCARD-1250 DES:MTOT DEP ID:X"]) {
    assert.equal(norm(norm(raw)), norm(raw), raw);
  }

  // corpus pass: truncated variants of one vendor merge into the longest; short keys and Zelle never merge
  const merged = mergeTruncatedKeys(["SEGOVIAS DISTRIBUTING INC", "SEGOVIAS DISTRIBU", "SEGOVIAS DISTR", "EL PASO PRODUC", "EL PASO PRODUCE", "AMAZON", "AMAZON DIGITAL SEATTLE", "ZELLE PAYMENT TO MARIA", "ZELLE PAYMENT TO MARIA LOPEZ", "TARGET"]);
  assert.equal(merged.get("SEGOVIAS DISTR"), "SEGOVIAS DISTRIBUTING INC");
  assert.equal(merged.get("SEGOVIAS DISTRIBU"), "SEGOVIAS DISTRIBUTING INC");
  assert.equal(merged.get("EL PASO PRODUC"), "EL PASO PRODUCE");
  assert.equal(merged.get("AMAZON"), "AMAZON", "short key does not swallow other vendors");
  assert.equal(merged.get("ZELLE PAYMENT TO MARIA"), "ZELLE PAYMENT TO MARIA", "people are never merged");
  assert.equal(merged.get("TARGET"), "TARGET");
}

// ===== 2. rule validation: the P&L hard rules ===========================================================
{
  const r = (o: Partial<RuleDef>): RuleDef => ({ id: "r", name: "r", pattern: "X", matchType: "STARTS_WITH", target: "normalized", direction: "out", kind: "EXPENSE", categoryName: "Supplies", priority: 1, confirmed: false, source: "USER", ...o });
  assert.deepEqual(validateRule(r({})), []);
  assert.match(validateRule(r({ categoryName: undefined }))[0], /needs a category/);
  assert.match(validateRule(r({ kind: "OWNER_DRAW", categoryName: "Supplies" }))[0], /must not have a category/);
  assert.match(validateRule(r({ kind: "CLOVER_SETTLEMENT", direction: "in", categoryName: "Supplies" }))[0], /must not have a category/);
  assert.ok(validateRule(r({ kind: "EXPENSE", direction: "in" })).some((e) => /only applies to outflows/.test(e)), "an expense can never be an inflow");
  assert.ok(validateRule(r({ kind: "VENDOR_REFUND", direction: "out" })).some((e) => /only applies to inflows/.test(e)));
  assert.ok(validateRule(r({ kind: "CLOVER_SETTLEMENT", categoryName: undefined, direction: "out" })).some((e) => /inflows/.test(e)));
  assert.deepEqual(validateRule(r({ kind: "SALES_TAX_REMITTANCE", categoryName: undefined, direction: "any" })), []);
  assert.ok(validateRule(r({ pattern: "(" , matchType: "REGEX" })).some((e) => /regular expression/.test(e)));
  assert.ok(validateRule(r({ pattern: "lower case" })).some((e) => /uppercase/.test(e)));
  assert.ok(validateRule(r({ amountMinCents: 500, amountMaxCents: 100 })).some((e) => /inverted/.test(e)));
  assert.ok(validateRule(r({ pattern: "" })).some((e) => /empty/.test(e)));
  // there is no revenue kind, and only these two kinds touch the P&L
  assert.ok(!(KINDS as readonly string[]).includes("REVENUE") && !(KINDS as readonly string[]).includes("INCOME"));
  assert.deepEqual([...PNL_KINDS].sort(), ["EXPENSE", "VENDOR_REFUND"]);
  assert.equal(KINDS.length, 11);
}

// ===== 3. engine semantics ===============================================================================
{
  const rule = (o: Partial<RuleDef>): RuleDef => ({ id: "r", name: "r", pattern: "ACME", matchType: "STARTS_WITH", target: "normalized", direction: "out", kind: "EXPENSE", categoryName: "Supplies", priority: 100, confirmed: true, source: "USER", ...o });
  const acme = (cents = 1000, account = BOA2879) => tx("CHECKCARD 0601 ACME SUPPLY EL PASO TX XXXXX1234", cents, account);
  const hit = (r: RuleDef, t: TxnInput) => ruleMatches(r, t, norm(t.raw));

  // match types
  assert.equal(hit(rule({ matchType: "EXACT", pattern: "ACME SUPPLY" }), acme()), true);
  assert.equal(hit(rule({ matchType: "EXACT", pattern: "ACME" }), acme()), false);
  assert.equal(hit(rule({ matchType: "STARTS_WITH", pattern: "ACME" }), acme()), true);
  assert.equal(hit(rule({ matchType: "STARTS_WITH", pattern: "SUPPLY" }), acme()), false);
  assert.equal(hit(rule({ matchType: "CONTAINS", pattern: "SUPPLY" }), acme()), true);
  assert.equal(hit(rule({ matchType: "REGEX", pattern: "^ACME\\s+(SUPPLY|CO)$" }), acme()), true);
  assert.equal(hit(rule({ matchType: "REGEX", pattern: "supply$" }), acme()), true, "regex is case-insensitive");
  // raw vs normalized target
  assert.equal(hit(rule({ target: "raw", matchType: "CONTAINS", pattern: "CHECKCARD 0601" }), acme()), true);
  assert.equal(hit(rule({ target: "normalized", matchType: "CONTAINS", pattern: "CHECKCARD" }), acme()), false);
  // direction
  assert.equal(hit(rule({ direction: "out" }), acme(1000)), true);
  assert.equal(hit(rule({ direction: "out" }), acme(-1000)), false);
  assert.equal(hit(rule({ direction: "in", kind: "VENDOR_REFUND" }), acme(-1000)), true);
  assert.equal(hit(rule({ direction: "any", kind: "SALES_TAX_REMITTANCE", categoryName: undefined }), acme(-1000)), true);
  // a kind cannot be applied to a direction it does not allow, even if the rule says "any"
  assert.equal(hit(rule({ direction: "any", kind: "EXPENSE" }), acme(-1000)), false, "EXPENSE never matches an inflow");
  assert.equal(hit(rule({ direction: "any", kind: "VENDOR_REFUND", categoryName: "Supplies" }), acme(1000)), false, "VENDOR_REFUND never matches an outflow");
  // account scope
  assert.equal(hit(rule({ accounts: [{ institution: "chase" }] }), acme(1000, CHASE)), true);
  assert.equal(hit(rule({ accounts: [{ institution: "chase" }] }), acme(1000, BOA2879)), false);
  assert.equal(hit(rule({ accounts: [{ mask: "9334" }] }), acme(1000, BOA9334)), true);
  assert.equal(hit(rule({ accounts: [{ mask: "9334" }] }), acme(1000, BOA2879)), false);
  assert.equal(hit(rule({ accounts: [{ type: "credit" }] }), acme(1000, CHASE)), true);
  assert.equal(hit(rule({ accounts: [{ mask: "9334" }, { institution: "Chase" }] }), acme(1000, CHASE)), true, "scope entries are alternatives");
  assert.equal(hit(rule({ accounts: [{ institution: "Chase", mask: "0000" }] }), acme(1000, CHASE)), false, "fields inside one entry must all match");
  // amount range on the absolute amount, inclusive
  assert.equal(hit(rule({ amountMinCents: 1000, amountMaxCents: 2000 }), acme(1000)), true);
  assert.equal(hit(rule({ amountMinCents: 1000, amountMaxCents: 2000 }), acme(2000)), true);
  assert.equal(hit(rule({ amountMinCents: 1000, amountMaxCents: 2000 }), acme(999)), false);
  assert.equal(hit(rule({ amountMinCents: 1000, amountMaxCents: 2000 }), acme(2001)), false);
  assert.equal(hit(rule({ direction: "in", kind: "VENDOR_REFUND", amountMinCents: 1000 }), acme(-1500)), true, "absolute amount for inflows");

  // ordering: priority, then specificity, then confirmed before unconfirmed, then id
  const ids = (rs: RuleDef[]) => sortRules(rs).map((r) => r.id);
  assert.deepEqual(ids([rule({ id: "b", priority: 100 }), rule({ id: "a", priority: 10 })]), ["a", "b"]);
  assert.deepEqual(ids([rule({ id: "contains", matchType: "CONTAINS" }), rule({ id: "exact", matchType: "EXACT" }), rule({ id: "starts", matchType: "STARTS_WITH" }), rule({ id: "regex", matchType: "REGEX", pattern: "A" })]), ["exact", "starts", "contains", "regex"]);
  assert.deepEqual(ids([rule({ id: "unconf", confirmed: false }), rule({ id: "conf", confirmed: true })]), ["conf", "unconf"]);
  assert.deepEqual(ids([rule({ id: "z" }), rule({ id: "a" })]), ["a", "z"]);

  // first match wins; unconfirmed rules classify but are marked
  const t = acme();
  const winner = classify([t], [rule({ id: "low", priority: 100, categoryName: "Other" }), rule({ id: "high", priority: 10, categoryName: "Supplies" })], { pairs: false })[0];
  assert.deepEqual([winner.ruleId, winner.categoryName, winner.status, winner.via], ["high", "Supplies", "AUTO", "rule"]);
  assert.equal(classify([acme()], [rule({ confirmed: false })], { pairs: false })[0].status, "AUTO_UNCONFIRMED");

  // defaults: unmatched outflow = review with no kind; unmatched inflow = OTHER_INFLOW, flagged for review. Never revenue.
  const unmatchedOut = classify([tx("SOMETHING UNKNOWN", 500)], [], { pairs: false })[0];
  assert.deepEqual([unmatchedOut.kind, unmatchedOut.status, unmatchedOut.via, unmatchedOut.categoryName], [null, "NEEDS_REVIEW", "default", null]);
  const unmatchedIn = classify([tx("SOMETHING UNKNOWN", -500)], [], { pairs: false })[0];
  assert.deepEqual([unmatchedIn.kind, unmatchedIn.status, unmatchedIn.categoryName], ["OTHER_INFLOW", "NEEDS_REVIEW", null]);

  // system rule: a payment credit on a credit card is a card payment (never income) even with no matching outflow
  const credit = classify([tx("Payment Thank You-Mobile", -12345, CHASE)], SEED_RULES)[0];
  assert.deepEqual([credit.kind, credit.via, credit.categoryName], ["CARD_PAYMENT", "system", null]);
  // ...but a merchant refund on the card is NOT a payment
  assert.equal(classify([tx("AMAZON MKTPLACE PMTS", -1947, CHASE)], SEED_RULES)[0].kind, "OTHER_INFLOW");
  // and the same words on a checking account are not the system rule
  assert.notEqual(classify([tx("Payment Thank You-Mobile", -12345, BOA2879)], SEED_RULES)[0].via, "system");
}

// ===== 4. pair matcher ===================================================================================
{
  const pairOf = (ts: TxnInput[], w?: number) => matchPairs(ts, w ? { windowDays: w } : {});
  // internal transfer between the two BoA accounts: both sides
  const out = tx("Online Banking transfer to CHK 9334 Confirmation# XXXXX111", 500000, BOA2879, "2026-05-20");
  const inn = tx("Online Banking transfer from CHK 2879 Confirmation# XXXXX112", -500000, BOA9334, "2026-05-20");
  let p = pairOf([out, inn]);
  assert.deepEqual([p.get(out.id)?.kind, p.get(inn.id)?.kind, p.get(out.id)?.pairedWith, p.get(inn.id)?.pairedWith], ["INTERNAL_TRANSFER", "INTERNAL_TRANSFER", inn.id, out.id]);
  const decided = classify([out, inn], SEED_RULES);
  assert.deepEqual(decided.map((d) => [d.kind, d.status, d.via]), [["INTERNAL_TRANSFER", "AUTO", "pair"], ["INTERNAL_TRANSFER", "AUTO", "pair"]]);

  // card payment across two bank connections: BoA ... CHASE CREDIT CRD EPAY <-> Chase "Payment Thank You"
  const pay = tx("CHASE CREDIT CRD DES:EPAY ID:XXXXX02639 INDN:CARD HOLDER CO ID:XXXXX99999 WEB", 825538, BOA2879, "2026-04-27");
  const credit = tx("Payment Thank You-Mobile", -825538, CHASE, "2026-04-24");
  p = pairOf([pay, credit]);
  assert.deepEqual([p.get(pay.id)?.kind, p.get(credit.id)?.kind, p.get(pay.id)?.gapDays], ["CARD_PAYMENT", "CARD_PAYMENT", 3]);

  // window: 5 days by default
  const late = tx("Payment Thank You-Mobile", -825538, CHASE, "2026-05-03"); // 6 days after
  assert.equal(pairOf([pay, late]).size, 0);
  assert.equal(pairOf([pay, late], 6).size, 2);

  // not paired: different amount, same account, tiny amounts, non-transfer descriptors
  assert.equal(pairOf([out, tx("Online Banking transfer from CHK 2879 Confirmation# X", -500001, BOA9334, "2026-05-20")]).size, 0);
  assert.equal(pairOf([out, tx("Online Banking transfer from CHK 2879 Confirmation# X", -500000, BOA2879, "2026-05-20")]).size, 0, "same account");
  assert.equal(pairOf([tx("Online Banking transfer to CHK 9334 Confirmation# X", 50, BOA2879), tx("Online Banking transfer from CHK 2879 Confirmation# X", -50, BOA9334)]).size, 0, "under $1");
  assert.equal(pairOf([tx("SAMS CLUB #650 EL PASO TX", 10000, BOA2879), tx("Zelle payment from SOMEONE Conf# a", -10000, BOA9334)]).size, 0, "a purchase is not a transfer");

  // a transfer that names ANOTHER account (CHK 3831) never pairs with an equal amount elsewhere
  const toThird = tx("Online Banking transfer to CHK 3831 Confirmation# XXXXX1", 250000, BOA2879, "2026-04-14");
  const coincidence = tx("Payment Thank You-Mobile", -250000, CHASE, "2026-04-16");
  assert.equal(pairOf([toThird, coincidence]).size, 0);
  const d = classify([toThird, coincidence], SEED_RULES);
  assert.deepEqual(d.map((x) => x.kind), ["OWNER_DRAW", "CARD_PAYMENT"], "draw via rule; the unpaired Chase credit is still a card payment (system rule)");
  // and a transfer naming CHK 9334 will not pair with an inflow on a different account mask
  const wrong = tx("Online Banking transfer from CHK 2879 Confirmation# X", -500000, { id: "x1", institution: "Bank of America", mask: "1111", type: "depository" }, "2026-05-20");
  assert.equal(pairOf([out, wrong]).size, 0);

  // one-to-one: two equal outflows, one inflow -> exactly one pair
  const o2 = tx("Online Banking transfer to CHK 9334 Confirmation# XXXXX999", 500000, BOA2879, "2026-05-21");
  p = pairOf([out, o2, inn]);
  assert.equal(p.size, 2);
  assert.equal(p.get(out.id)?.ambiguous, false, "the exact-date candidate wins without ambiguity");
  // equal gap candidates are flagged ambiguous (and then classified as unconfirmed)
  const i1 = tx("Online Banking transfer from CHK 2879 Confirmation# A", -70000, BOA9334, "2026-05-19");
  const i2 = tx("Online Banking transfer from CHK 2879 Confirmation# B", -70000, BOA9334, "2026-05-21");
  const o3 = tx("Online Banking transfer to CHK 9334 Confirmation# C", 70000, BOA2879, "2026-05-20");
  const amb = pairOf([o3, i1, i2]);
  assert.equal(amb.get(o3.id)?.ambiguous, true);
  assert.equal(classify([o3, i1, i2], SEED_RULES).find((x) => x.txnId === o3.id)?.status, "AUTO_UNCONFIRMED");
  // a credit-card OUTflow (purchase) is never treated as a payment
  assert.equal(pairOf([tx("CHASE CREDIT CRD EPAY", 10000, CHASE), tx("Online Banking transfer from CHK 2879 Confirmation# X", -10000, BOA2879)]).size, 0);
  // deterministic regardless of input order
  assert.deepEqual([...pairOf([inn, out, o2])].sort(), [...pairOf([o2, out, inn])].sort());
}

// ===== 5. seed rules against real descriptor shapes ======================================================
{
  assert.ok(SEED_RULES.every((r) => r.source === "SEED"));
  // exactly the rules the owner confirmed are confirmed; everything else (incl. Target) is still unconfirmed
  const CONFIRMED = [
    "seed:owner-draw-3831", "seed:owner-contribution-3831", "seed:checks-rent", "seed:davo-sales-tax", "seed:firstlight-fcu",
    "seed:creamland:purchase", "seed:creamland:refund", "seed:sj-mexican:purchase", "seed:sj-mexican:refund",
    "seed:sams-club:purchase", "seed:sams-club:refund", "seed:walmart:purchase", "seed:walmart:refund", "seed:home-depot:purchase", "seed:home-depot:refund",
    // the owner accepted the four additions and the MEXICAN SPECIA variant
    "seed:bankcard-discount", "seed:clover-app", "seed:chase-card-payment", "seed:transfer-between-boa", "seed:mexican-specialty:purchase", "seed:mexican-specialty:refund",
  ].sort();
  assert.deepEqual(SEED_RULES.filter((r) => r.confirmed).map((r) => r.id).sort(), CONFIRMED);
  for (const id of ["seed:target:purchase", "seed:target:refund", "seed:economy-cash-carry:purchase", "seed:clover-settlement", "seed:payroll-homebase", "seed:cash-atm-deposit", "seed:webstaurant:purchase"]) {
    assert.equal(SEED_RULES.find((r) => r.id === id)?.confirmed, false, id);
  }
  assert.ok(OWNER_DECISION_RULE_IDS.every((id) => SEED_RULES.some((r) => r.id === id)) && ADDITION_RULE_IDS.every((id) => SEED_RULES.some((r) => r.id === id)));
  assert.equal(new Set(SEED_RULES.map((r) => r.id)).size, SEED_RULES.length, "unique ids");
  for (const r of SEED_RULES) assert.deepEqual(validateRule(r), [], r.id);

  type Expect = [string, number, TxnInput["account"], string | null, string | null];
  const cases: Expect[] = [
    // settlement / cash / owner
    ["BANKCARD-1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SD CCD", -90000, BOA2879, "CLOVER_SETTLEMENT", null],
    ["BANKCARD 1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SD CCD", -90000, BOA2879, "CLOVER_SETTLEMENT", null],
    ["BKOFAMERICA ATM 10/26 #XXXXX2228 DEPOSIT JOE BATTLE EL PASO TX CKCD XXXXXXXXXX123456", -50000, BOA2879, "CASH_DEPOSIT", null],
    ["Counter Credit", -120000, BOA2879, "CASH_DEPOSIT", null],
    ["Online Banking transfer to CHK 3831 Confirmation# XXXXX6", 100000, BOA2879, "OWNER_DRAW", null],
    ["Online Banking transfer from CHK 3831 Confirmation# XXXXX6", -100000, BOA9334, "OWNER_CONTRIBUTION", null],
    // payroll, sales tax (both directions), fees, interest
    ["Payroll-Homebase DES:PCR ID:dbfdcfb9a99c99e INDN:La Michoacana Yummy LL CO ID:XXXXX99999 CCD", 250000, BOA9334, "EXPENSE", "Wages"],
    ["DAVO TECHNOLOGIE DES:ACH ID:888-659-8432 INDN:LA MICHOACANA YUMMY LA CO ID:XXXXX12345 PPD", 11000, BOA2879, "SALES_TAX_REMITTANCE", null],
    ["DAVO TECHNOLOGIE DES:40AF0774-8 ID:888-659-8432 INDN:LA MICHOACANA YUMMY LA CO ID:XXXXX12345 PPD", -87001, BOA2879, "SALES_TAX_REMITTANCE", null],
    ["CLOVER FEES DES:CLOVER FEE ID:1187264 INDN:LA MICHOACANA YUMMY CO ID:XXXXX99999 CCD", 24200, BOA2879, "EXPENSE", "Card processing fees"],
    ["BANKCARD-1250 DES:MTOT DISC ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SM CCD", 5500, BOA2879, "EXPENSE", "Card processing fees"],
    ["CLOVER APP DES:CLOVER APP ID:1187264 INDN:LA MICHOACANA YUMMY CO ID:XXXXX99999 PPD", 22643, BOA2879, "EXPENSE", "Software and subscriptions"],
    ["PURCHASE INTEREST CHARGE", 14000, CHASE, "EXPENSE", "Interest"],
    // utilities, COGS, supplies (purchase and refund)
    ["B2P*EL PASO ELECTRIC", 91000, CHASE, "EXPENSE", "Utilities"],
    ["CHECKCARD 0511 B2P*EL PASO ELECT XXXXX21634 TX XXXXX8461XXXXXXXXXX1234 CKCD 4900", 92900, BOA2879, "EXPENSE", "Utilities"],
    ["EL PASO WATER UTILITIES", 33000, BOA2879, "EXPENSE", "Utilities"],
    ["CREAMLAND", 120000, CHASE, "EXPENSE", CAT.DAIRY],
    ["ECONOMY CASH A 11/04 #XXXXX4300 PURCHASE 411 N ZARAGOZA EL PASO TX CKCD 5300", 28000, BOA2879, "EXPENSE", CAT.DAIRY],
    ["RESTAURANT DEP 10/13 #XXXXX3165 MOBILE PURCHASE RESTAURANT DEPOT EL PASO TX CKCD 5300", 21000, BOA2879, "EXPENSE", CAT.DAIRY],
    ["RESTAURANT DEP 10/06 #XXXXX1329 REFUND RESTAURANT DEPOT EL PASO TX", -25979, BOA2879, "VENDOR_REFUND", CAT.DAIRY],
    ["CORTEZ WHOLESA 10/13 #XXXXX0433 PURCHASE 111 N PIEDRAS STR EL PASO TX CKCD 5300", 40000, BOA2879, "EXPENSE", CAT.DAIRY],
    ["CHECKCARD 1013 THE WEBSTAURANT S XXXXX27472 PA XXXXX9062XXXXXXXXXX1234 CKCD 5300", 14000, BOA2879, "EXPENSE", "Supplies"],
    ["CHECKCARD 1109 SAMSCLUB.COM XXXXX67726 AR XXXXX8253XXXXXXXXXX1234 CKCD 5300", 18000, BOA2879, "EXPENSE", "Supplies"],
    ["SAMS CLUB.COM", 9000, CHASE, "EXPENSE", "Supplies"],
    ["SAMS CLUB #6502", -4400, CHASE, "VENDOR_REFUND", "Supplies"],
    ["CHECKCARD 1125 Walmart.com Bentonville AR CKCD 5310 XXXXXXXXXX123456", 4300, BOA2879, "EXPENSE", "Supplies"],
    ["Walmart.com 10/12 #XXXXX1234 REFUND Walmart.com Bentonville AR CKCD 5311", -3194, BOA2879, "VENDOR_REFUND", "Supplies"],
    ["THE HOME DEPOT 10/02 #XXXXX2114 PURCHASE 12221 MONTWOOD DR EL PASO TX CKCD 5200", 15000, BOA2879, "EXPENSE", "Supplies"],
    ["TARGET T-2216 11/08 #XXXXX9530 PURCHASE TARGET T-2216 El Paso TX CKCD 5310", 9500, BOA2879, "EXPENSE", "Supplies"],
    // loan
    ["FirstLight FCU DES:ACH ORGTN ID:XXXXXXXXXX88468 INDN:SOMEONE,NAME CO ID:XXXXX99999 PPD", 36000, BOA2879, "LOAN_PAYMENT", null],
    // additions beyond the list
    ["CHASE CREDIT CRD DES:EPAY ID:XXXXX02639 INDN:CARD HOLDER CO ID:XXXXX99999 WEB", 200000, BOA2879, "CARD_PAYMENT", null],
    ["Online Banking transfer to CHK 9334 Confirmation# XXXXX555", 110000, BOA2879, "INTERNAL_TRANSFER", null],
    // MUST stay in the review queue (kind null for outflows; OTHER_INFLOW for inflows)
    ["Check 1391", 26804, BOA2879, null, null],
    ["Zelle payment to MIGUEL LOPEZ Conf# wrwwdn4fc", 50000, BOA2879, null, null],
    ["Zelle Scheduled payment to Mom for \"Sams\"; Conf# un15hjj", 4200, BOA2879, null, null],
    ["BKOFAMERICA BC 11/10 #XXXXX3088 WITHDRWL 1810 N Zaragoza R El Paso TX", 440001, BOA2879, null, null],
    ["BKOFAMERICA ATM 11/14 #XXXXX2581 WITHDRWL EDGEMERE AND TIERRA EL PASO TX CKCD XXXXXXXXXX123456", 20000, BOA2879, null, null],
    ["CHECKCARD 0127 TACO CABANA 20297 EL PASO TX XXXXX5261XXXXXXXXXX1234 CKCD 5814", 2272, BOA2879, null, null],
    ["CHECKCARD 1215 WHATABURGER 634 EL PASO TX XXXXX8653XXXXXXXXXX1234 CKCD 5814", 2876, BOA2879, null, null],
    ["CHECKCARD 0917 MCDONALD'S F2671 EL PASO TX XXXXX4853XXXXXXXXXX1234 CKCD 5814", 907, BOA2879, null, null],
    ["PMNT SENT 1119 CASH APP*LIZETH C XXXXX91940 CA XXXXX5553", 2500, BOA2879, null, null],
    ["Online Banking transfer to SAV 2870 Confirmation# XXXXX85782", 83333, BOA2879, null, null],
    ["Zelle payment from HUBERT G TERRAZAS Conf# 99c3k43ik", -53500, BOA2879, "OTHER_INFLOW", null],
    ["BKOFAMERICA MOBILE 11/29 XXXXX07337 DEPOSIT *MOBILE TX", -28703, BOA2879, "OTHER_INFLOW", null],
    // owner's answers: rent checks, S.J. Mexican (both SQ variants and its refund), the unconfirmed truncated variant
    ["Check 1391", 440951, BOA2879, "EXPENSE", CAT.RENT],
    ["Check 169", 438501, BOA2879, "EXPENSE", CAT.RENT],
    ["Check 169", 430000, BOA2879, "EXPENSE", CAT.RENT], // $4,300.00 is inclusive
    ["Check 169", 450000, BOA2879, "EXPENSE", CAT.RENT], // $4,500.00 is inclusive
    ["Check 169", 429999, BOA2879, null, null],
    ["Check 169", 450001, BOA2879, null, null],
    ["Check 169", 505800, BOA2879, null, null], // May's $5,058.00 check is NOT swept into rent
    ["Check 169", 37600, BOA2879, null, null],
    ["CHECKCARD 1006 SQ *S. J. MEXICAN El Paso TX XXXXX8662XXXXXXXXXX1234 CKCD 5812", 40551, BOA2879, "EXPENSE", CAT.CANDY],
    ["SQ *S. J. MEXICAN SPECIAL", 48256, CHASE, "EXPENSE", CAT.CANDY],
    ["SQ *S. J. MEXICAN SPECIAL", -4000, CHASE, "VENDOR_REFUND", CAT.CANDY],
    ["MEXICAN SPECIA 10/13 #XXXXX5817 PURCHASE 3600 ALAMEDA AVE EL PASO TX CKCD 5499", 9100, BOA2879, "EXPENSE", CAT.CANDY],
    ["CHECKCARD 0210 TARGET.COM * XXXXX99999 MN XXXXX9999XXXXXXXXXX9999 CKCD 5310", 3400, BOA2879, "EXPENSE", CAT.SUPPLIES],
  ];
  for (const [raw, cents, account, kind, category] of cases) {
    const d = one(tx(raw, cents, account));
    assert.equal(d.kind, kind, `${raw.slice(0, 60)} -> ${String(d.kind)}`);
    assert.equal(d.categoryName, category, `category for ${raw.slice(0, 60)}`);
    const matched = SEED_RULES.find((r) => r.id === d.ruleId);
    const expected = d.via === "default" ? "NEEDS_REVIEW" : matched?.confirmed ? "AUTO" : "AUTO_UNCONFIRMED";
    assert.equal(d.status, expected, `status for ${raw.slice(0, 50)}`);
  }

  // scoping: Chase interest does not apply to the same words on a BoA account
  assert.equal(one(tx("PURCHASE INTEREST CHARGE", 14000, BOA2879)).kind, null);
  // an outflow never matches a refund rule and an inflow never matches a purchase rule
  assert.equal(one(tx("SAMS CLUB #6502", 4400, CHASE)).kind, "EXPENSE");
  assert.equal(one(tx("SAMS CLUB #6502", -4400, CHASE)).kind, "VENDOR_REFUND");
  // the settlement rule is inflow-only: the same descriptor as a debit is not a settlement
  assert.notEqual(one(tx("BANKCARD-1250 DES:MTOT DEP ID:X INDN:Y CCD", 90000)).kind, "CLOVER_SETTLEMENT");
}

// ===== 6. hard rule as a property: random transactions can never produce revenue or a P&L inflow ============
{
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const raws = [
    ...["SAMS CLUB #6502", "Walmart.com 10/12 #XXXXX1234 REFUND", "CREAMLAND", "B2P*EL PASO ELECTRIC", "THE HOME DEPOT #1", "BANKCARD-1250 DES:MTOT DEP ID:X INDN:Y CCD", "DAVO TECHNOLOGIE DES:ACH ID:1 INDN:Y", "Counter Credit",
      "Payroll-Homebase DES:RFD ID:X INDN:Y", "Online Banking transfer from CHK 3831 Confirmation# X", "Online Banking transfer to CHK 3831 Confirmation# X", "Payment Thank You-Mobile", "CHASE CREDIT CRD DES:EPAY ID:X INDN:Y", "random vendor", "Zelle payment from X Conf# a", "CLOVER FEES DES:CLOVER FEE ID:1 INDN:Y", "PURCHASE INTEREST CHARGE"],
  ];
  const accounts = [BOA2879, BOA9334, CHASE];
  const txns: TxnInput[] = Array.from({ length: 4000 }, (_, i) => tx(raws[0][Math.floor(rnd() * raws[0].length)], Math.floor(rnd() * 200000 - 100000) || 1, accounts[Math.floor(rnd() * 3)], `2026-0${1 + Math.floor(rnd() * 9)}-${10 + Math.floor(rnd() * 15)}`, { id: `p${i}` }));
  const out = classify(txns, SEED_RULES);
  for (const d of out) {
    if (d.direction === "in") assert.notEqual(d.kind, "EXPENSE", "no inflow is ever an expense");
    if (d.direction === "out") assert.notEqual(d.kind, "VENDOR_REFUND");
    if (d.kind) {
      const allowed = KIND_DIRECTIONS[d.kind];
      assert.ok(allowed === "both" || allowed === d.direction, `${d.kind} applied to a ${d.direction}`);
      assert.equal(!!d.categoryName, PNL_KINDS.has(d.kind), `${d.kind} category presence`);
    }
    if (d.status === "NEEDS_REVIEW") assert.ok(d.kind === null || d.kind === "OTHER_INFLOW");
  }
  // internal transfers and card payments balance: every paired outflow has its inflow
  const paired = out.filter((d) => d.via === "pair");
  assert.equal(paired.length % 2, 0);
  for (const d of paired) assert.equal(out.find((x) => x.txnId === d.pairedWith)?.pairedWith, d.txnId, "pairs are mutual");
}

// ===== 7. planned category changes, cash notes, quick picks ================================================
{
  // rename + addition, applied in memory only; idempotent; never duplicates
  const before = [{ name: "Ingredients and dairy", section: "COGS" }, { name: "Supplies", section: "OPEX" }];
  const a = applyPlannedCategoryChanges(before);
  assert.deepEqual(a.categories.map((c) => c.name), ["Dairy & ingredients", "Supplies", "Candy & toppings"]);
  assert.deepEqual(a.categories.find((c) => c.name === "Candy & toppings")?.section, "COGS");
  assert.equal(a.notes.length, 2);
  assert.deepEqual(before.map((c) => c.name), ["Ingredients and dairy", "Supplies"], "input is not mutated");
  const b = applyPlannedCategoryChanges(a.categories);
  assert.deepEqual(b.notes, [], "applying twice changes nothing");
  assert.equal(b.categories.length, a.categories.length);
  // if both names already exist, the old one is left alone (no silent merge)
  const both = applyPlannedCategoryChanges([{ name: "Ingredients and dairy", section: "COGS" }, { name: "Dairy & ingredients", section: "COGS" }]);
  assert.equal(both.categories.filter((c) => c.name === "Dairy & ingredients").length, 1);
  assert.ok(both.categories.some((c) => c.name === "Ingredients and dairy"));
  assert.deepEqual(PLANNED_CATEGORY_CHANGES.renames, [{ from: "Ingredients and dairy", to: "Dairy & ingredients" }]);
  // every category a seed rule uses exists after the planned changes (given the categories prisma/seed.ts creates)
  const seedCats = new Set(["Dairy & ingredients", "Candy & toppings", "Cones, cups and packaging", "Other COGS", "Wages", "Rent", "Utilities", "Supplies", "Card processing fees", "Software and subscriptions", "Interest"]);
  for (const r of SEED_RULES) if (r.categoryName) assert.ok(seedCats.has(r.categoryName), `${r.id} uses unknown category ${r.categoryName}`);

  // cash notes: only when something of that kind happened; amounts are absolute
  assert.deepEqual(cashNotesFor([]), []);
  assert.deepEqual(cashNotesFor([{ kind: "EXPENSE", cents: 5000 }, { kind: null, cents: 100 }]), []);
  const notes = cashNotesFor([{ kind: "LOAN_PAYMENT", cents: 36000 }, { kind: "LOAN_PAYMENT", cents: -36000 }, { kind: "EXPENSE", cents: 100 }]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].id, notes[0].kind, notes[0].count, notes[0].totalCents], ["loan-payments", "LOAN_PAYMENT", 2, 72000]);
  assert.equal(notes[0].text, "Loan payments — interest portion deductible; accountant needs the loan statement.");
  assert.equal(CASH_NOTES.LOAN_PAYMENT?.text, notes[0].text);
  // FirstLight is a non-P&L loan payment that triggers the note
  const fl = one(tx("FirstLight FCU DES:ACH ORGTN ID:X INDN:Y CO ID:Z PPD", 36000));
  assert.deepEqual([fl.kind, fl.categoryName, fl.status], ["LOAN_PAYMENT", null, "AUTO"]);
  assert.equal(cashNotesFor([{ kind: fl.kind, cents: 36000 }])[0].id, "loan-payments");

  // quick picks: checks get Payroll / Vendor-COGS / Other, per transaction only; Zelle gets the four labels with a recipient rule offer
  assert.deepEqual(quickPicksFor("CHECK"), CHECK_PICKS);
  assert.deepEqual(CHECK_PICKS.map((p) => p.label), ["Payroll", "Vendor / COGS", "Other"]);
  assert.ok(CHECK_PICKS.every((p) => p.offerRule === "none"), "no rule is offered for a payee-less check");
  assert.deepEqual(CHECK_PICKS.map((p) => [p.kind, p.categoryName]), [["EXPENSE", CAT.WAGES], ["EXPENSE", CAT.OTHER_COGS], [null, null]]);
  assert.deepEqual(quickPicksFor("ZELLE PAYMENT TO MARIA LOPEZ"), ZELLE_PICKS);
  assert.deepEqual(quickPicksFor("ZELLE SCHEDULED PAYMENT TO MOM"), ZELLE_PICKS);
  assert.deepEqual(ZELLE_PICKS.map((p) => p.label), ["Staff", "Family", "Vendor", "Other"]);
  assert.deepEqual(quickPicksFor("SAMS CLUB"), [], "other items use the full picker");
  assert.deepEqual(quickPicksFor("ZELLE PAYMENT FROM SOMEONE"), [], "money received is not a recipient to label as staff");
  for (const p of [...CHECK_PICKS, ...ZELLE_PICKS]) { if (p.kind) assert.ok(p.kind === "EXPENSE" || p.kind === "OWNER_DRAW"); }
}

// ===== 8. Zelle: counterparty, cadence, per-recipient summary, recipient-level rules ============================
{
  const cp = extractZelleCounterparty;
  assert.deepEqual(cp("Zelle payment to MIGUEL LOPEZ Conf# wrwwdn4fc"), { direction: "to", name: "MIGUEL LOPEZ", scheduled: false });
  assert.deepEqual(cp("Zelle payment to gabe terrazas Conf# tecmnmvfa"), { direction: "to", name: "gabe terrazas", scheduled: false });
  assert.deepEqual(cp("Zelle payment to Yummy Nydia Esbobar-Nunez Conf# ya7pg7rjc"), { direction: "to", name: "Yummy Nydia Esbobar-Nunez", scheduled: false });
  assert.deepEqual(cp('Zelle Scheduled payment to Mom for "Sams"; Conf# un15hjj'), { direction: "to", name: "Mom", scheduled: true });
  assert.deepEqual(cp('Zelle payment from CAROLINA GUTIERREZ for "pizza"; Conf# 99c3k43ik'), { direction: "from", name: "CAROLINA GUTIERREZ", scheduled: false });
  assert.deepEqual(cp("Zelle payment from HUBERT G TERRAZAS Conf# 99c3k43ik"), { direction: "from", name: "HUBERT G TERRAZAS", scheduled: false });
  assert.equal(cp("Online Banking transfer to CHK 3831"), null);
  assert.equal(cp("Zelle payment to  Conf# x"), null);
  assert.equal(recipientKey("gabe  terrazas"), recipientKey("Gabe Terrazas"));

  // long names survive normalization (they decide the rule), unlike the generic 6-token cap
  assert.equal(norm("Zelle payment to Yummy Nydia Esbobar-Nunez Conf# ya7pg7rjc"), "ZELLE PAYMENT TO YUMMY NYDIA ESBOBAR NUNEZ");
  assert.equal(norm("Zelle payment to Aida Garcia Zamarripa Conf# uiqz3v5v4"), "ZELLE PAYMENT TO AIDA GARCIA ZAMARRIPA");

  // cadence
  const fridays = ["2026-01-02", "2026-01-16", "2026-01-30", "2026-02-13", "2026-02-27", "2026-03-13"];
  const c1 = cadenceOf(fridays, [50000, 50500, 49500, 50000, 51000, 50000]);
  assert.deepEqual([c1.period, c1.regular, c1.consistentAmounts, c1.medianGapDays], ["biweekly", true, true, 14]);
  assert.match(c1.hint, /^~biweekly, consistent amounts → likely staff/);
  const c2 = cadenceOf(["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"], [30000, 45000, 20000, 52000, 38000]);
  assert.deepEqual([c2.period, c2.regular, c2.consistentAmounts], ["weekly", true, false]);
  assert.match(c2.hint, /^~weekly, varying amounts → possibly staff/);
  const c3 = cadenceOf(["2026-01-05", "2026-02-09", "2026-02-12", "2026-05-30", "2026-09-01"], [10000, 90000, 5000, 70000, 25000]);
  assert.equal(c3.period, null);
  assert.match(c3.hint, /^irregular \(median gap \d+ days\), varying amounts → likely a vendor or one-off$/);
  const c4 = cadenceOf(["2026-01-05", "2026-02-20", "2026-04-02", "2026-06-15"], [100000, 100000, 100000, 100000]);
  assert.match(c4.hint, /irregular .*consistent amounts → could be family or a fixed vendor/);
  assert.equal(cadenceOf(["2026-01-05"], [100]).hint, "single payment");
  assert.match(cadenceOf(["2026-01-05", "2026-01-19"], [100, 100]).hint, /two payments 14 days apart/);
  assert.equal(cadenceOf(["2026-01-05", "2026-01-12", "2026-01-19"], [100, 100, 100]).period, "weekly");

  // per-recipient summary: one row per person (case-insensitive), sorted by total, sent vs received separated
  const item = (raw: string, date: string, cents: number, account = "BoA ••2879") => ({ raw, date, cents, account });
  const items = [
    item("Zelle payment to Gabe Terrazas Conf# a", "2026-01-10", 40000), item("Zelle payment to gabe terrazas Conf# b", "2026-02-10", 20000, "BoA ••9334"),
    ...fridays.map((d, i) => item(`Zelle payment to Yummy Alex Marquez Conf# ${i}`, d, 50000)),
    item("Zelle payment to Mama Conf# m", "2025-12-01", 90000), item("Zelle payment to Mama Conf# n", "2026-01-01", 90000), item("Zelle payment to Mama Conf# o", "2026-02-01", 90000),
    item("Zelle payment from HUBERT G TERRAZAS Conf# z", "2026-03-03", -50000),
    item("Online Banking transfer to CHK 3831", "2026-03-03", 99999),
  ];
  const sent = summarizeRecipients(items, "to");
  assert.deepEqual(sent.map((r) => r.key), ["YUMMY ALEX MARQUEZ", "MAMA", "GABE TERRAZAS"], "sorted by total, the Online Banking transfer ignored");
  const gabe = sent.find((r) => r.key === "GABE TERRAZAS")!;
  assert.deepEqual([gabe.name, gabe.count, gabe.totalCents, gabe.medianCents, gabe.first, gabe.last, gabe.typicalGapDays, gabe.total2026Cents], ["Gabe Terrazas", 2, 60000, 30000, "2026-01-10", "2026-02-10", 31, 60000], "most common casing, merged across casings");
  assert.deepEqual(gabe.accounts, ["BoA ••2879", "BoA ••9334"]);
  const alex = sent[0];
  assert.equal(alex.count, 6);
  assert.ok(alex.signals.includes("saved with a 'Yummy' contact name"));
  assert.ok(alex.signals.some((x) => /mostly Fridays \(6 of 6\)/.test(x)));
  assert.match(alex.cadence.hint, /likely staff/);
  const mama = sent.find((r) => r.key === "MAMA")!;
  assert.equal(mama.total2026Cents, 180000, "2026 total excludes 2025");
  assert.equal(mama.medianCents, 90000);
  assert.equal(mama.totalCents, 270000);
  const recv = summarizeRecipients(items, "from");
  assert.deepEqual(recv.map((r) => r.key), ["HUBERT G TERRAZAS"]);
  assert.equal(recv[0].totalCents, 50000, "received amounts are reported as positive money");
  // a strong single-weekday pattern outranks "irregular" even when weeks are skipped
  const skipped = ["2026-01-02", "2026-01-30", "2026-02-13", "2026-04-03", "2026-04-24"].map((d, i) => item(`Zelle payment to Dana Staff Conf# ${i}`, d, [20000, 50000, 31000, 70000, 15000][i]));
  assert.match(summarizeRecipients(skipped, "to")[0].cadence.hint, /^paid mostly Fridays \(5 of 5\), varying amounts → likely staff \(pay day\)$/);

  // recipient-level rules: shape and behavior (designed here; NONE are seeded)
  assert.ok(!SEED_RULES.some((r) => r.id.startsWith("zelle:")), "no recipient rules are seeded");
  assert.deepEqual(zelleRecipientRules({ name: "Someone", label: "OTHER" }), []);
  assert.throws(() => zelleRecipientRules({ name: "Someone", label: "VENDOR" }), /needs a category/);
  const staff = zelleRecipientRules({ name: "Yummy Alex Marquez", label: "STAFF" });
  assert.deepEqual(staff.map((r) => [r.direction, r.kind, r.categoryName, r.confirmed, r.source, r.priority]), [["out", "EXPENSE", CAT.WAGES, true, "USER", 50]]);
  const family = zelleRecipientRules({ name: "Gabe Terrazas", label: "FAMILY" });
  assert.deepEqual(family.map((r) => [r.direction, r.kind, r.categoryName]), [["out", "OWNER_DRAW", undefined], ["in", "OWNER_CONTRIBUTION", undefined]]);
  const vend = zelleRecipientRules({ name: "Segovia Distributing", label: "VENDOR", vendorCategory: CAT.DAIRY });
  assert.deepEqual(vend.map((r) => [r.direction, r.kind, r.categoryName]), [["out", "EXPENSE", CAT.DAIRY], ["in", "VENDOR_REFUND", CAT.DAIRY]]);
  for (const r of [...staff, ...family, ...vend]) assert.deepEqual(validateRule(r), [], r.id);
  assert.equal(new Set([...staff, ...family, ...vend].map((r) => r.id)).size, 5, "unique ids");

  // behavior against real-shaped descriptors: matches that person only, scheduled or not, either casing, outranks seeds
  const rules = [...SEED_RULES, ...staff, ...family, ...vend];
  const k = (raw: string, cents: number) => one(tx(raw, cents), rules);
  assert.deepEqual([k("Zelle payment to Yummy Alex Marquez Conf# xbdw90cjk", 52000).kind, k("Zelle payment to Yummy Alex Marquez Conf# xbdw90cjk", 52000).categoryName], ["EXPENSE", CAT.WAGES]);
  assert.equal(k("Zelle payment to yummy alex marquez Conf# q", 52000).kind, "EXPENSE", "casing does not matter");
  assert.equal(k('Zelle Scheduled payment to Yummy Alex Marquez for "x"; Conf# q', 52000).kind, "EXPENSE", "scheduled variant");
  assert.equal(k("Zelle payment to Yummy Alex Marquez Conf# x", -52000).kind, "OTHER_INFLOW", "staff rule is outflow-only; money received stays in review");
  assert.equal(k("Zelle payment to Yummy Alex Marquezzz Conf# x", 52000).kind, null, "a different spelling is a different person");
  assert.equal(k("Zelle payment to Yummy Alexander Marquez Conf# x", 52000).kind, null);
  assert.equal(k("Zelle payment to Yummy Aileen Gonzalez Conf# x", 40000).kind, null, "an unlabeled person stays in review");
  assert.equal(k("Zelle payment to Gabe Terrazas Conf# x", 40000).kind, "OWNER_DRAW");
  assert.equal(k("Zelle payment from Gabe Terrazas Conf# x", -40000).kind, "OWNER_CONTRIBUTION");
  assert.equal(k("Zelle payment to Segovia Distributing Conf# x", 9000).kind, "EXPENSE");
  assert.equal(k("Zelle payment from Segovia Distributing Conf# x", -9000).kind, "VENDOR_REFUND");
  // never revenue: no recipient rule can turn a received payment into income
  for (const label of ["STAFF", "FAMILY", "VENDOR"] as const) {
    for (const r of zelleRecipientRules({ name: "Pat Person", label, vendorCategory: CAT.SUPPLIES })) {
      assert.ok(r.direction === "out" ? ["EXPENSE", "OWNER_DRAW"].includes(r.kind) : ["OWNER_CONTRIBUTION", "VENDOR_REFUND"].includes(r.kind));
    }
  }
  // regex metacharacters in a name are escaped
  const odd = zelleRecipientRules({ name: "Jo (Jr.) O'Neil", label: "STAFF" })[0];
  assert.deepEqual(validateRule(odd), []);
  assert.equal(one(tx("Zelle payment to Jo (Jr.) O'Neil Conf# x", 1000), [odd]).kind, "EXPENSE");
  assert.equal(one(tx("Zelle payment to Jo JrX O'Neil Conf# x", 1000), [odd]).kind, null);
}

// ===== 9. the owner's confirmed USER rules ==========================================================================
{
  assert.ok(USER_RULES.every((r) => r.source === "USER" && r.confirmed && r.priority === 50), "USER, confirmed, outrank seeds");
  assert.ok(USER_RULES.every((r) => r.note === "Confirmed by Stephen"));
  for (const r of USER_RULES) assert.deepEqual(validateRule(r), [], r.id);
  assert.equal(new Set(ALL_RULES.map((r) => r.id)).size, ALL_RULES.length, "ids unique across seed and user rules");
  assert.equal(USER_RULES.length, 16, "8 vendors x (purchase + refund)");
  const k = (raw: string, cents: number, account = BOA2879) => one(tx(raw, cents, account), ALL_RULES);
  const cases: [string, number, string, string][] = [
    ["EL PASO PRODUC 10/13 #XXXXX3812 PURCHASE 3701 ALAMEDA AVE EL PASO TX CKCD 5499 XXXXXXXXXX123456", 9341, "EXPENSE", CAT.DAIRY],
    ["EL PASO PRODUCE", 8200, "EXPENSE", CAT.DAIRY],
    ["SEGOVIAS DISTR 10/08 #XXXXX8851 PURCHASE 3701 SHELL STREET EL PASO TX CKCD 5411 XXXXXXXXXX123456", 13087, "EXPENSE", CAT.DAIRY],
    ["CHECKCARD 0903 SEGOVIAS DISTRIBU EL PASO TX XXXXX1234XXXXXXXXXX1234 CKCD 5411 XXXXXXXXXX123456", 5100, "EXPENSE", CAT.DAIRY],
    ["SEGOVIAS DISTRIBUTING INC", 31500, "EXPENSE", CAT.DAIRY],
    ["ALTA DENA CERTIFIED DAIRY", 137072, "EXPENSE", CAT.DAIRY],
    ["OVERDRAFT ITEM FEE FOR ACTIVITY OF 06-18 ELECTRONIC TRANSACTION POSTING DATE 06-19-26 POSTING SEQUENCE 123", 1000, "EXPENSE", CAT.BANK_FEES],
    ["OVERDRAFT ITEM FEE FOR ACTIVITY OF 06-18 CHECK #XXXXX12345 POSTING DATE 06-19-26", 1000, "EXPENSE", CAT.BANK_FEES],
    ["OVERDRAFT ITEM FEE FOR ACTIVITY OF 06-18 ELECTRONIC TRANSACTION POSTING DATE 06-19-26", -1000, "VENDOR_REFUND", CAT.BANK_FEES],
    ["joinhomebase.com DES:joinhomeba ID:ST-C9G9U9F9B9I9 INDN:IRIS TERRAZAS CO ID:XXXXX99999 CCD", 11260, "EXPENSE", CAT.PAYROLL_SERVICE],
    ["PURCHASE 1020 ATT*BILL PAYMENT XXXXX99999 TX XXXXX9999XXXXXXXXXX9999 RECURRING CKCD 4814 XXXXXXXXXX123456", 9720, "EXPENSE", CAT.INTERNET_PHONE],
    ["ATT*BILL PAYMENT", 9720, "EXPENSE", CAT.INTERNET_PHONE],
    ["CHECKCARD 0814 WIX.COM XXXXX9999 XXXXX99999 CA XXXXX9999XXXXXXXXXX9999 RECURRING CKCD 7372 XXXXXXXXXX123456", 4850, "EXPENSE", CAT.SOFTWARE],
    ["PURCHASE 0814 Wix.com XXXXX9999 XXXXX99999 NY XXXXX9999XXXXXXXXXX9999 RECURRING CKCD 7372", 4850, "EXPENSE", CAT.SOFTWARE],
    ["Farmers Ins Exch DES:EFT PYMT ID:fXXXXX9999 INDN:. Iris Terrazas CO ID:XXXXX99999 CCD", 12123, "EXPENSE", CAT.INSURANCE],
    ["Farmers Ins Exch DES:EFT PYMT ID:fXXXXX9999 INDN:La Michoacana Yummy LL CO ID:XXXXX99999 WEB", 12123, "EXPENSE", CAT.INSURANCE],
  ];
  for (const [raw, cents, kind, cat] of cases) {
    const d = k(raw, cents);
    assert.deepEqual([d.kind, d.categoryName, d.status], [kind, cat, "AUTO"], raw.slice(0, 50));
    assert.ok(d.ruleId?.startsWith("user:"), `${raw.slice(0, 40)} decided by a user rule`);
  }
  // not confused with look-alikes
  assert.equal(k("SPROUTS FARMER 10/12 #XXXXX9999 MOBILE PURCHASE SPROUTS FARMERS EL PASO TX CKCD 5411", 2500).kind, null, "Sprouts Farmers Market is not Farmers Insurance");
  assert.equal(k("PAYROLL HOMEBASE DES:PCR ID:X INDN:La Michoacana Yummy LL CO ID:XXXXX99999 CCD", 250000).categoryName, CAT.WAGES, "payroll runs stay Wages; only the joinhomebase subscription is Payroll service fees");
  assert.equal(k("WIXOM MICHIGAN HARDWARE", 1500).kind, null, "WIX needs a word boundary");
  assert.equal(k("ATTORNEY OFFICE", 50000).kind, null);
  // and the owner's rules outrank a seed rule that would also match
  const rival = { ...SEED_RULES[0], id: "seed:rival", pattern: "EL PASO PRODUC", direction: "out" as const, kind: "EXPENSE" as const, categoryName: CAT.SUPPLIES, priority: 100, confirmed: false };
  const both = one(tx("EL PASO PRODUC 10/13 #XXXXX3812 PURCHASE", 5000), [rival, ...USER_RULES]);
  assert.equal(both.categoryName, CAT.DAIRY);
}

console.log("rules ok");
