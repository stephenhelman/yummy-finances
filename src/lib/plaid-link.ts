import { CountryCode, Products, type LinkTokenCreateRequest } from "plaid";
import { PLAID_DAYS_REQUESTED } from "@/lib/plaid-config";

/** What the user sees in Plaid Link (max 30 characters). */
export const PLAID_CLIENT_NAME = "Yummy Finances";

/**
 * The single place link-token requests are built, so a new connection and an update-mode
 * reconnect always carry the same redirect_uri (needed for OAuth banks).
 */
export function buildLinkTokenRequest(args: { userId: string; redirectUri?: string; accessToken?: string }): LinkTokenCreateRequest {
  const base: LinkTokenCreateRequest = {
    user: { client_user_id: args.userId },
    client_name: PLAID_CLIENT_NAME,
    country_codes: [CountryCode.Us],
    language: "en",
    ...(args.redirectUri ? { redirect_uri: args.redirectUri } : {}),
  };
  // Update mode re-authenticates an existing Item: no products, no new Item.
  if (args.accessToken) return { ...base, access_token: args.accessToken };
  // New connection. days_requested cannot be changed once the Item exists.
  return { ...base, products: [Products.Transactions], transactions: { days_requested: PLAID_DAYS_REQUESTED } };
}

/** A registered-URI problem surfaces as INVALID_FIELD naming the redirect URI. */
export function isRedirectUriProblem(summary: string): boolean {
  return /redirect uri/i.test(summary);
}
