import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { isDevAuthBypass } from "@/lib/dev-auth";
import { adminEmails, isAdminEmail } from "@/lib/env";
import { isMailConfigured } from "@/lib/apps-script";
import { sendLoginEmail } from "@/lib/email";
import { passcodeStatus } from "@/lib/passcode";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
} from "@/lib/session";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The single business row (single-tenant for now). */
export async function getBusiness() {
  return db.business.findFirstOrThrow();
}

/**
 * Emails a sign-in link if `email` is allowlisted. Never reveals whether the
 * address is allowed: callers show the same message either way.
 */
export async function requestMagicLink(rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !isAdminEmail(email) || !isMailConfigured()) return;

  const business = await getBusiness();
  const recent = await db.loginToken.count({
    where: { businessId: business.id, email, createdAt: { gt: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_TOKENS_PER_WINDOW) return;

  const token = randomBytes(32).toString("base64url");
  await db.loginToken.create({
    data: {
      businessId: business.id,
      email,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });

  const base = process.env.APP_URL ?? "http://localhost:3000";
  const link = `${base}/auth/verify?token=${token}`;
  await sendLoginEmail({ to: email, link, expiresMinutes: TOKEN_TTL_MS / 60_000 });
}

/** Atomically consumes a token. Returns the email on success, else null. */
export async function consumeMagicLink(token: string): Promise<string | null> {
  const row = await db.loginToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null;
  const { count } = await db.loginToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count !== 1 || !isAdminEmail(row.email)) return null;
  return row.email;
}

export async function startSession(email: string): Promise<void> {
  await setSessionCookie(await createSessionToken(email));
}

/** Same cookie, expiry and signature as a magic-link session; attributed as "passcode", no email. */
export async function startPasscodeSession(): Promise<void> {
  await setSessionCookie(await createSessionToken("", Date.now(), "passcode"));
}

async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Authoritative check for admin pages and handlers (proxy is only an optimistic
 * redirect). Re-checks the allowlist so removing an email revokes access, and
 * rejects passcode sessions once LOGIN_PASSCODE is unset. `actor` is what to
 * record in the audit log: the email, or "passcode".
 */
export async function requireAdmin(): Promise<{ email: string | null; actor: string }> {
  if (isDevAuthBypass()) {
    const email = adminEmails()[0] ?? "dev@localhost";
    return { email, actor: email };
  }
  const jar = await cookies();
  const session = await verifySessionToken(jar.get(SESSION_COOKIE)?.value);
  if (session?.via === "passcode") {
    if (passcodeStatus() !== "enabled") redirect("/login");
    return { email: null, actor: "passcode" };
  }
  if (!session || !isAdminEmail(session.email)) redirect("/login");
  return { email: session.email, actor: session.email };
}
