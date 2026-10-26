import { callAppsScript, type AppsScriptOptions } from "@/lib/apps-script";

/** Sends the magic-link sign-in email through the Apps Script mailer. Throws on failure. */
export async function sendLoginEmail(
  args: { to: string; link: string; expiresMinutes: number },
  opts?: AppsScriptOptions,
): Promise<void> {
  await callAppsScript({ type: "login_email", ...args }, opts);
}
