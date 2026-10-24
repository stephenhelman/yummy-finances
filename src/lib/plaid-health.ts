// Pure classification of Plaid Item health (no I/O), so it can be unit-tested.

export type ItemStatus = "OK" | "LOGIN_REQUIRED" | "PENDING_EXPIRATION" | "ERROR";

/** Errors the user fixes by re-authenticating through Link update mode. */
const LOGIN_REQUIRED_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ITEM_LOCKED",
  "USER_PERMISSION_REVOKED",
  "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "INSUFFICIENT_CREDENTIALS",
]);

/** Warn this long before bank consent lapses. */
export const CONSENT_WARNING_DAYS = 7;

/** Statuses on which the admin page offers "Reconnect bank". */
export const RECONNECT_STATUSES: readonly ItemStatus[] = ["LOGIN_REQUIRED", "PENDING_EXPIRATION"];

export type ItemHealth = { status: ItemStatus; errorCode: string | null; message: string | null };

export function classifyErrorCode(code: string): ItemStatus {
  return LOGIN_REQUIRED_CODES.has(code) ? "LOGIN_REQUIRED" : "ERROR";
}

/** From the parts of a /item/get response (or API error) that matter. An error always beats a consent warning. */
export function classifyItem(
  input: { error: { error_code?: string | null; error_message?: string | null } | null | undefined; consentExpirationTime: string | null | undefined },
  now: Date,
): ItemHealth {
  const code = input.error?.error_code;
  if (code) return { status: classifyErrorCode(code), errorCode: code, message: input.error?.error_message ?? null };

  if (input.consentExpirationTime) {
    const expires = Date.parse(input.consentExpirationTime);
    if (Number.isFinite(expires) && expires - now.getTime() <= CONSENT_WARNING_DAYS * 86_400_000) {
      return { status: "PENDING_EXPIRATION", errorCode: "CONSENT_EXPIRING", message: `Bank consent expires ${input.consentExpirationTime}` };
    }
  }
  return { status: "OK", errorCode: null, message: null };
}

/** Account types synced by default: depository and credit. Loans, investments and other are off. */
export function defaultIncluded(type: string | null | undefined): boolean {
  return type === "depository" || type === "credit";
}
