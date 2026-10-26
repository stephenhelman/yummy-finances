import { createHash, timingSafeEqual } from "node:crypto";

// Optional shared-passcode login. Disabled unless LOGIN_PASSCODE is set and long enough.
// Pure logic with injected storage so it can be tested without a database; see passcode-db.ts.

export const MIN_PASSCODE_LENGTH = 20;
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

type Env = Record<string, string | undefined>;

export type PasscodeStatus = "unset" | "too_short" | "enabled";

export function passcodeStatus(env: Env = process.env): PasscodeStatus {
  const p = env.LOGIN_PASSCODE;
  if (!p) return "unset";
  return p.length >= MIN_PASSCODE_LENGTH ? "enabled" : "too_short";
}

/** Constant-time comparison (hashing first makes the buffers equal length). */
export function passcodeMatches(input: string, expected: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(input), h(expected));
}

export type PasscodeStore = {
  /** Timestamps of failed passcode attempts from this IP at or after `since`. */
  recentFailures(ip: string, since: Date): Promise<Date[]>;
  /** Records an attempt. Never receives the passcode. */
  record(event: "failed" | "locked" | "ok", ip: string): Promise<void>;
};

export type PasscodeResult =
  | { ok: true }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "locked"; retryAfterMinutes: number };

export async function attemptPasscodeLogin(
  input: string,
  ip: string,
  store: PasscodeStore,
  env: Env = process.env,
  now = Date.now(),
): Promise<PasscodeResult> {
  if (passcodeStatus(env) !== "enabled") return { ok: false, reason: "disabled" };

  const failures = await store.recentFailures(ip, new Date(now - ATTEMPT_WINDOW_MS));
  if (failures.length >= MAX_FAILED_ATTEMPTS) {
    await store.record("locked", ip);
    // The lock lifts when the oldest counted failure ages out of the window.
    const oldest = Math.min(...failures.map((d) => d.getTime()));
    return { ok: false, reason: "locked", retryAfterMinutes: Math.max(1, Math.ceil((oldest + ATTEMPT_WINDOW_MS - now) / 60_000)) };
  }

  if (passcodeMatches(input, env.LOGIN_PASSCODE!)) {
    await store.record("ok", ip);
    return { ok: true };
  }
  await store.record("failed", ip);
  return { ok: false, reason: "wrong" };
}

/** Best-effort client IP. On Vercel the platform sets x-forwarded-for. */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
}
