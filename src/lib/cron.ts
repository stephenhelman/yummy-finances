import { timingSafeEqual } from "node:crypto";

/**
 * Guards cron routes. Vercel sends `Authorization: Bearer $CRON_SECRET`.
 * Returns a Response to send back if the request is NOT authorized, else null.
 */
export function rejectUnlessCron(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET not configured", { status: 500 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
