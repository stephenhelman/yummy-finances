// Descriptor normalizer: turns a bank's raw transaction text into a stable merchant key so the same
// vendor written five different ways ends up as one key. Built from real descriptors (BoA and Chase).
//
// Two BoA layouts exist and both are handled:
//   prefix layout: "CHECKCARD 1109 SAMSCLUB.COM XXXXX67726 AR XXXXX8253… CKCD 5300 XXXXXXXXXX123456"
//   suffix layout: "ECONOMY CASH A 11/04 #XXXXX4300 PURCHASE 411 N ZARAGOZA EL PASO TX CKCD 5300 …"
//                  (the merchant name is cut at ~14 characters, hence the aliases below)
// ACH layout: "<ORIGINATOR> DES:<type> ID:… INDN:… CO ID:…" keeps the originator plus a readable type.

const STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

// Longest first so "MOBILE PURCHASE" is tried before "PURCHASE".
const PREFIXES = ["RECURRING PAYMENT", "PURCHASE REFUND", "MOBILE PURCHASE", "POS DEBIT", "CHECKCARD", "PMNT SENT", "PMNT RCVD", "RECURRING", "PURCHASE", "POS"];

/** Payment-processor prefixes (SQ *Vendor, TST*Vendor, B2P*Vendor, ...): dropped, the vendor is what follows. */
const PROCESSOR_PREFIXES = new Set(["SQ", "TST", "B2P", "PP", "PAYPAL"]);
const ACH_NOISE = new Set(["ACH", "WEB", "PPD", "CCD", "CTX", "TEL"]);

/** Bank-branch transaction words worth keeping in the key (they decide cash deposit vs withdrawal). */
const BRANCH_TYPES = /\b(WITHDRWL|DEPOSIT|FR CHKG|TO CHKG)\b/;

/** Canonical vendor keys: collapses spelling variants and the bank's 14-character truncation. */
const ALIASES: [RegExp, string][] = [
  [/\bSAMS? ?CLUB\b|\bSAMSCLUB\b/, "SAMS CLUB"],
  [/\bWAL ?MART\b/, "WALMART"],
  [/\bHOME DEPOT\b/, "HOME DEPOT"],
  [/^TARGET\b/, "TARGET"],
  [/\bECONOMY CASH\b/, "ECONOMY CASH AND CARRY"],
  [/\bRESTAURANT DEP/, "RESTAURANT DEPOT"],
  [/\bCORTEZ WHO/, "CORTEZ WHOLESALE"],
  [/\bWEBSTAURANT/, "WEBSTAURANT STORE"],
  [/\bEL PASO ELECT/, "EL PASO ELECTRIC"], // bank truncates to "EL PASO ELECT"
  [/\bEL PASO WATER\b/, "EL PASO WATER"],
  [/\bCREAMLAND\b/, "CREAMLAND"],
];

const MAX_TOKENS = 6;
/** Zelle keys end in a person's name, which can be several words: keep enough of it to tell people apart. */
const MAX_TOKENS_ZELLE = 10;

function isMmdd(t: string): boolean {
  if (!/^\d{4}$/.test(t)) return false;
  const m = Number(t.slice(0, 2)), d = Number(t.slice(2));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** "SQ *S. J. MEXICAN" -> "S. J. MEXICAN";  "AUDIBLE*W77U70KS3" -> "AUDIBLE";  "GOOGLE *YOUTUBE TV" -> "GOOGLE YOUTUBE TV". */
function starStep(s: string): string {
  return s.replace(/(\S*?)\s*\*\s*(\S*)/g, (_m, left: string, right: string) => {
    if (PROCESSOR_PREFIXES.has(left)) return ` ${right}`;
    if (/\d/.test(right)) return ` ${left}`; // a reference code
    return ` ${left} ${right}`;
  });
}

/** Strips numbers, masks, punctuation. Account numbers after CHK/SAV are kept: they say WHICH account. */
function cleanTokens(s: string): string {
  let t = s.replace(/'/g, "");
  t = t.replace(/\b([A-Z0-9_-]+)\.(?:COM|NET|ORG|CO)\b/g, "$1"); // WALMART.COM -> WALMART
  t = t.replace(/\b(?:DATE|TIME|TRN|REF|ID|SEQ):\S*/g, " ");
  t = t.replace(/\bCKCD\s*\d*/g, " ");
  t = t.replace(/CONF(?:IRMATION)?#\s*\S*/g, " ");
  t = t.replace(/X{3,}\w*/g, " "); // masked number runs: XXXXX67726, XXXXXXXXXX123456
  t = t.replace(/#\s*\S*/g, " "); // store / reference numbers: #650, #XXXXX4300
  // protect account numbers ("CHK 3831") behind letter-only placeholders while digits are stripped
  const accounts: string[] = [];
  t = t.replace(/\b(CHK|SAV)\s+(\d{3,4})\b/g, (_m, kind: string, digits: string) => {
    accounts.push(`${kind} ${digits}`);
    return ` ZZACCT${String.fromCharCode(65 + accounts.length - 1)}ZZ `;
  });
  t = t.replace(/\d+/g, " ").replace(/[^A-Z\s]/g, " ");
  t = t.replace(/ZZACCT([A-Z])ZZ/g, (_m, i: string) => accounts[i.charCodeAt(0) - 65]);
  return t.replace(/\s+/g, " ").trim();
}

/** Drops a trailing state ("TX") and then the home city ("EL PASO"): "S J MEXICAN EL PASO TX" -> "S J MEXICAN". */
function trimLocation(tokens: string[]): string[] {
  const t = [...tokens];
  if (t.length > 1 && t[t.length - 1].length === 2 && STATES.has(t[t.length - 1])) t.pop();
  if (t.length > 2 && t[t.length - 2] === "EL" && t[t.length - 1] === "PASO") t.splice(-2, 2);
  return t;
}

function alias(key: string): string {
  for (const [re, canonical] of ALIASES) if (re.test(key)) return canonical;
  return key;
}

function finish(s: string): string {
  const tokens = trimLocation(s.split(" ").filter(Boolean));
  while (tokens.length > 1 && tokens[0] === "THE") tokens.shift();
  const key = tokens.slice(0, tokens[0] === "ZELLE" ? MAX_TOKENS_ZELLE : MAX_TOKENS).join(" ");
  return alias(key) || "(BLANK)";
}

export function normalizeDescriptor(raw: string): string {
  let s = raw.toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (!s) return "(BLANK)";

  // Zelle/other memos: ... FOR "Sams";
  s = s.replace(/\s+FOR\s+["“].*$/, "");

  // ACH: ORIGINATOR DES:type ID:... INDN:... -> originator + a readable (letters-only) type
  const ach = /^(.+?)\s+DES:\s*(.*)$/.exec(s);
  if (ach) {
    const originator = cleanTokens(starStep(ach[1]));
    const desText = ach[2].split(/\s+(?:ID|INDN|CO ID|ORIG ID|PMT INFO):/)[0].trim();
    let des = "";
    if (/^[A-Z ]+$/.test(desText)) {
      const origWords = new Set(originator.split(" "));
      const words = desText.split(" ").filter((w) => w && !ACH_NOISE.has(w));
      // "CLOVER FEES DES:CLOVER FEE" -> the type repeats the name: drop it
      if (words.length && !origWords.has(words[0])) des = words.join(" ");
    } // hex/uuid-like types (DES:40AF0774-8) are noise and are dropped
    return finish([originator, des].filter(Boolean).join(" "));
  }

  s = s.replace(/CONF(?:IRMATION)?#\s*\S*/g, " ");

  // leading transaction-type words, then the MMDD that follows them
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of PREFIXES) {
      if (s === p || s.startsWith(`${p} `)) {
        s = s.slice(p.length).trim();
        changed = true;
        break;
      }
    }
  }
  const [first, ...restTokens] = s.split(" ");
  if (isMmdd(first)) s = restTokens.join(" ");

  // suffix layout: "<MERCHANT> MM/DD #XXXXX1234 PURCHASE <street, city, state>"
  let branchType = "";
  const suffix = /^(.*?)\s+(\d{2}\/\d{2})(?:\s+(.*))?$/.exec(s);
  if (suffix && suffix[1]) {
    // only the part AFTER the date can hold the type: text already in the key (e.g. a key being re-normalized) is left alone
    branchType = BRANCH_TYPES.exec(suffix[3] ?? "")?.[1] ?? "";
    s = suffix[1];
  }

  const cleaned = cleanTokens(starStep(s));
  // keep deposit/withdrawal words for bank-branch/ATM rows only (they decide cash deposit vs withdrawal)
  const keepType = branchType && /^BKOFAMERICA\b/.test(cleaned) ? ` ${branchType}` : "";
  return finish(cleaned + keepType);
}

/**
 * Corpus-level pass for the review queue: the bank cuts merchant names at a fixed width, so one vendor
 * shows up as "SEGOVIAS DISTRIBUTING INC", "SEGOVIAS DISTRIBU", "SEGOVIAS DISTR". A key is merged into a
 * LONGER key that starts with it (the shorter key must be at least `minLength` characters so a short
 * word never swallows unrelated vendors). Zelle keys are never merged: they end in a person's name.
 * Returns key -> canonical (longest) key.
 */
export function mergeTruncatedKeys(keys: Iterable<string>, minLength = 11): Map<string, string> {
  const unique = [...new Set(keys)].sort((a, b) => b.length - a.length || a.localeCompare(b)); // longest first
  const result = new Map<string, string>();
  const canonical: string[] = [];
  for (const key of unique) {
    const target = /^ZELLE\b/.test(key) ? undefined : canonical.find((c) => c.length > key.length && key.length >= minLength && c.startsWith(key));
    if (target) result.set(key, target);
    else {
      result.set(key, key);
      canonical.push(key);
    }
  }
  return result;
}
