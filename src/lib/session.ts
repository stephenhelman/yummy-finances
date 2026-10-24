// Stateless signed session cookie (HMAC-SHA256 via Web Crypto, so it runs in
// both route handlers and proxy). Payload: { email, exp }.

export const SESSION_COOKIE = "yf_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

type Session = { email: string; exp: number };

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set (32+ chars)");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionToken(email: string, now = Date.now()): Promise<string> {
  const payload = b64url(
    enc.encode(JSON.stringify({ email: email.toLowerCase(), exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })),
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Returns the session if the signature is valid and unexpired, else null. */
export async function verifySessionToken(token: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      Buffer.from(sig, "base64url"),
      enc.encode(payload),
    );
    if (!ok) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof session.email !== "string" || typeof session.exp !== "number") return null;
    if (session.exp * 1000 <= now) return null;
    return session;
  } catch {
    return null;
  }
}
