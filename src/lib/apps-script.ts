import { scrub } from "@/lib/preflight-env";

type Env = Record<string, string | undefined>;

export type MonthlyReportPayload = {
  year: number;
  month: number;
  businessName: string;
  sections: {
    key: string;
    label: string;
    subtotalCents: number;
    /** Text of the subtotal row. Default "Total <label>". */
    subtotalLabel?: string;
    /** false = no header row (a bare subtotal such as "Total Expenses"). Default true. */
    header?: boolean;
    /** true = lines only, no subtotal row. Default false. */
    noSubtotal?: boolean;
  }[];
  lines: { section: string; label: string; cents: number }[];
  netCents?: number;
  /** Print Net Income right after this section (default: after the last one). */
  netAfterSection?: string;
  cashNotes: string[];
  warnings: string[];
  recipients: string[];
};

export type AppsScriptRequest =
  | { type: "ping" }
  | { type: "login_email"; to: string; link: string; expiresMinutes: number }
  | ({ type: "monthly_report" } & MonthlyReportPayload);

export type AppsScriptOptions = {
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Whether the email mailer is configured (both URL and secret present). */
export function isMailConfigured(env: Env = process.env): boolean {
  return !!env.APPS_SCRIPT_URL?.trim() && !!env.APPS_SCRIPT_SECRET;
}

export class AppsScriptError extends Error {}

/**
 * POSTs one request to the Apps Script web app. Throws AppsScriptError on any failure.
 * Never logs, and never puts the secret or the payload into an error message.
 */
export async function callAppsScript(req: AppsScriptRequest, opts: AppsScriptOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const url = env.APPS_SCRIPT_URL?.trim();
  const secret = env.APPS_SCRIPT_SECRET;
  if (!url) throw new AppsScriptError("APPS_SCRIPT_URL is not set");
  if (!secret) throw new AppsScriptError("APPS_SCRIPT_SECRET is not set");

  const timeoutMs = opts.timeoutMs ?? (req.type === "monthly_report" ? 120_000 : 30_000);
  let res: Response;
  try {
    // text/plain keeps this a "simple" request; the script parses the body as JSON itself.
    // Google answers the POST with a redirect that fetch follows (as a GET) to fetch the response.
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...req, secret }),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new AppsScriptError(timedOut ? `Apps Script timed out after ${timeoutMs / 1000}s` : "Apps Script request failed (network error)");
  }

  let body: { ok?: unknown; error?: unknown } | null = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new AppsScriptError(
      `Apps Script returned a web page, not JSON (HTTP ${res.status}). Check the deployment is "Anyone" and APPS_SCRIPT_URL ends in /exec`,
    );
  }
  if (body?.ok === true) return;
  const detail = typeof body?.error === "string" ? scrub(body.error, { APPS_SCRIPT_SECRET: secret }).slice(0, 200) : `HTTP ${res.status}`;
  throw new AppsScriptError(`Apps Script rejected the request: ${detail}`);
}
