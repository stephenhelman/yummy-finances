import { db } from "@/lib/db";
import type { PasscodeStore } from "@/lib/passcode";

const ACTION = { failed: "login_passcode_failed", locked: "login_passcode_locked", ok: "login_passcode_ok" } as const;

/** Passcode attempts live in the audit log (IP only, never the passcode). */
export const passcodeStore: PasscodeStore = {
  async recentFailures(ip, since) {
    const rows = await db.auditLog.findMany({
      where: { action: ACTION.failed, createdAt: { gte: since }, payload: { path: ["ip"], equals: ip } },
      select: { createdAt: true },
    });
    return rows.map((r) => r.createdAt);
  },
  async record(event, ip) {
    const business = await db.business.findFirstOrThrow({ select: { id: true } });
    await db.auditLog.create({
      data: { businessId: business.id, actor: "passcode", action: ACTION[event], entity: "login", payload: { ip } },
    });
  },
};
