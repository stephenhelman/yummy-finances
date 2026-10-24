// Redaction for probe output. Numbers (amounts, timestamps) are kept because
// the point of the probe is to learn what they mean; anything that identifies
// a person, card, device or the merchant is replaced.

const SENSITIVE_KEY =
  /name|email|phone|address|street|city|zip|postal|card|last4|first6|token|secret|employee|customer|device|serial|owner|ssn|tax.?id|ein|account|routing|iban|external|note|signature|authcode|reference|ref$/i;

// Keys that look sensitive but are structural and useful; checked first.
const SAFE_KEY = /^(amount|taxAmount|tipAmount|cashbackAmount|result|status|createdTime|modifiedTime|clientCreatedTime|voided|currency|tenderType|label|cardType|entryType|type|timezone|timeZone|percentage|total)$/i;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS = /\d{9,}/;

/** Stable short alias for an id so related records can still be correlated by eye. */
export function aliasId(id: string): string {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  return `id_${h.toString(16).padStart(8, "0")}`;
}

function redactString(key: string, v: string): string {
  if (key === "id" || key.endsWith("Id")) return aliasId(v);
  if (EMAIL.test(v) || LONG_DIGITS.test(v)) return "[redacted]";
  return v;
}

export function redact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "id") {
        out[k] = typeof v === "string" ? aliasId(v) : v;
      } else if (!SAFE_KEY.test(k) && SENSITIVE_KEY.test(k) && v !== null && typeof v !== "boolean") {
        out[k] = typeof v === "object" ? "[redacted object]" : "[redacted]";
      } else {
        out[k] = redact(v, k);
      }
    }
    return out;
  }
  if (typeof value === "string") return redactString(key, value);
  return value;
}

/** Key -> JSON type for every key path, so field names are visible even where values are redacted. */
export function shapeOf(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(value)) {
    out[prefix || "(root)"] = "array";
    for (const v of value.slice(0, 3)) shapeOf(v, `${prefix}[]`, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) shapeOf(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    const t = value === null ? "null" : typeof value;
    const p = prefix || "(root)";
    out[p] = out[p] && out[p] !== t ? `${out[p]}|${t}` : t;
  }
  return out;
}

/** Paths (and redacted-safe values) of anything that looks like a timezone setting. */
export function findTimezoneFields(value: unknown, prefix = "", out: { path: string; value: unknown }[] = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (/time.?zone|^tz$/i.test(k)) out.push({ path: p, value: v });
      findTimezoneFields(v, p, out);
    }
  }
  return out;
}
