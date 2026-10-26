import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requestMagicLink } from "@/lib/auth";
import { isMailConfigured } from "@/lib/apps-script";
import { isDevAuthBypass } from "@/lib/dev-auth";
import { passcodeStatus } from "@/lib/passcode";

export const metadata: Metadata = { title: "Sign in" };

async function sendLink(formData: FormData) {
  "use server";
  await requestMagicLink(String(formData.get("email") ?? ""));
  redirect("/login?sent=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (isDevAuthBypass()) redirect("/admin");
  const { sent, error, locked } = await searchParams;
  const mail = isMailConfigured();
  const passcode = passcodeStatus() === "enabled";
  const lockedMinutes = typeof locked === "string" ? Math.max(1, Number.parseInt(locked, 10) || 15) : null;
  return (
    <main className="login-wrap">
      <div className="wordmark">
        Yummy <span>Finances</span>
      </div>
      <div className="card login-card">
        {sent && mail ? (
          <div className="stack" role="status">
            <h1>Check your email</h1>
            <p>If that address is allowed, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
            <a className="btn btn-secondary btn-block" href="/login">Use a different email</a>
          </div>
        ) : (
          <div className="stack">
            <h1>Sign in</h1>
            {!mail && !passcode ? (
              <div className="alert alert-bad" role="alert">
                <strong>Sign-in isn&rsquo;t set up</strong>
                <p>No sign-in method is configured on this server yet.</p>
              </div>
            ) : null}
            {lockedMinutes ? (
              <div className="alert alert-bad" role="alert">
                <strong>Too many attempts</strong>
                <p>Passcode sign-in is locked for about {lockedMinutes} more minute{lockedMinutes === 1 ? "" : "s"}.</p>
              </div>
            ) : error === "passcode" ? (
              <div className="alert alert-bad" role="alert">
                <strong>That passcode didn&rsquo;t work</strong>
                <p>Check it and try again.</p>
              </div>
            ) : error ? (
              <div className="alert alert-bad" role="alert">
                <strong>That link didn&rsquo;t work</strong>
                <p>It may have expired or already been used. Request a new one.</p>
              </div>
            ) : null}
            {mail ? (
              <form action={sendLink} className="stack">
                <p className="muted">We&rsquo;ll email you a link. No password needed.</p>
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" className="input" />
                </div>
                <button type="submit" className="btn btn-primary btn-block">Email me a link</button>
              </form>
            ) : null}
            {passcode ? (
              <form method="post" action="/api/auth/passcode" className="stack">
                <div className="field">
                  <label htmlFor="passcode">Passcode</label>
                  <input id="passcode" name="passcode" type="password" required autoComplete="current-password" autoCapitalize="none" className="input" />
                </div>
                <button type="submit" className={mail ? "btn btn-secondary btn-block" : "btn btn-primary btn-block"}>Sign in with passcode</button>
              </form>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
