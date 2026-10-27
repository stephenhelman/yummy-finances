import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. The version prefix leaves room for
// format changes; KEY rotation is handled by ENCRYPTION_KEY_PREVIOUS below.
//
// Rotation: encrypt() ALWAYS uses ENCRYPTION_KEY. decrypt() tries ENCRYPTION_KEY first and, only if
// that fails authentication, ENCRYPTION_KEY_PREVIOUS (when set). So during a rotation both old and new
// ciphertexts stay readable, and the rotate-tokens route moves everything onto the current key.
const VERSION = "v1";
const IV_BYTES = 12;

function parseKey(name: "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS"): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes, base64-encoded (openssl rand -base64 32)`);
  }
  return key;
}

/** The previous key, or null when not set or identical to the current one. A malformed value is a config error. */
function previousKey(current: Buffer): Buffer | null {
  if (!process.env.ENCRYPTION_KEY_PREVIOUS?.trim()) return null;
  const prev = parseKey("ENCRYPTION_KEY_PREVIOUS");
  return prev.equals(current) ? null : prev;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", parseKey("ENCRYPTION_KEY"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

function decryptWith(key: Buffer, payload: string): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognized ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export type KeyUsed = "current" | "previous";

/** Decrypts with the current key, falling back to the previous one. Reports which key worked. */
export function decryptDetailed(payload: string): { plaintext: string; key: KeyUsed } {
  const current = parseKey("ENCRYPTION_KEY");
  try {
    return { plaintext: decryptWith(current, payload), key: "current" };
  } catch (e) {
    const prev = previousKey(current); // throws if ENCRYPTION_KEY_PREVIOUS is malformed: a config error, not a mismatch
    if (!prev) throw e;
    return { plaintext: decryptWith(prev, payload), key: "previous" };
  }
}

export function decrypt(payload: string): string {
  return decryptDetailed(payload).plaintext;
}

/** Which key reads this ciphertext: "current", "previous", or "none". Never throws on a bad ciphertext. */
export function probeKey(payload: string): KeyUsed | "none" {
  try {
    return decryptDetailed(payload).key;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("ENCRYPTION_KEY")) throw e; // configuration problem
    return "none";
  }
}

/** Whether a previous key is configured (and distinct from the current one). */
export function hasPreviousKey(): boolean {
  return previousKey(parseKey("ENCRYPTION_KEY")) !== null;
}
