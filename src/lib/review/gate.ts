import { db } from "@/lib/db";
import { ClassificationPendingError, requireClassification } from "@/lib/rules/readiness";

/** True when classification has been backfilled. Every screen that reads kind / category / review status goes through this. */
export async function classificationIsReady(businessId: string): Promise<boolean> {
  try {
    await requireClassification(db, businessId);
    return true;
  } catch (e) {
    if (e instanceof ClassificationPendingError) return false;
    throw e;
  }
}

/** Only same-site admin paths: stops a forged returnTo from bouncing the browser elsewhere. */
export function safeReturnTo(value: unknown, fallback: string): string {
  const s = typeof value === "string" ? value : "";
  return /^\/admin(\/|\?|$)/.test(s) && !s.startsWith("//") && !s.includes("\\") ? s : fallback;
}

/** returnTo with a one-shot message, replacing any earlier one. */
export function withMessage(path: string, kind: "notice" | "error", message: string): string {
  const u = new URL(path, "http://x");
  u.searchParams.delete("notice");
  u.searchParams.delete("error");
  u.searchParams.set(kind, message.slice(0, 300));
  return `${u.pathname}${u.search}`;
}
