import { NextResponse } from "next/server";
import { rejectUnlessCron } from "@/lib/cron";
import { runPreflight } from "@/lib/preflight";

// Runs the preflight inside the deployed environment, so production secrets never leave Vercel.
// Auth: `Authorization: Bearer $CRON_SECRET`. Output is check names and outcomes, never values.
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;
  const checks = await runPreflight({ context: "server" });
  const ok = !checks.some((c) => c.status === "fail");
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
