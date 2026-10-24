import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requestMagicLink } from "@/lib/auth";
import { isDevAuthBypass } from "@/lib/dev-auth";

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
  const { sent, error } = await searchParams;
  return (
    <main className="login-wrap">
      <div className="wordmark">
        Yummy <span>Finances</span>
      </div>
      <div className="card login-card">
        {sent ? (
          <div className="stack" role="status">
            <h1>Check your email</h1>
            <p>If that address is allowed, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
            <a className="btn btn-secondary btn-block" href="/login">Use a different email</a>
          </div>
        ) : (
          <form action={sendLink} className="stack">
            <h1>Sign in</h1>
            <p className="muted">We&rsquo;ll email you a link. No password needed.</p>
            {error ? (
              <div className="alert alert-bad" role="alert">
                <strong>That link didn&rsquo;t work</strong>
                <p>It may have expired or already been used. Request a new one.</p>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" className="input" />
            </div>
            <button type="submit" className="btn btn-primary btn-block">Email me a link</button>
          </form>
        )}
      </div>
    </main>
  );
}
