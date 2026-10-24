import type { Metadata } from "next";

export const metadata: Metadata = { title: "Confirm sign in" };

// The emailed link lands here and requires a click (POST) to consume the
// token, so mail scanners that prefetch links can't burn it.
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="login-wrap">
      <div className="wordmark">
        Yummy <span>Finances</span>
      </div>
      <div className="card login-card">
        {typeof token !== "string" || !token ? (
          <div className="stack" role="alert">
            <h1>Link incomplete</h1>
            <p>This sign-in link is missing its code. Request a new one.</p>
            <a className="btn btn-secondary btn-block" href="/login">Back to sign in</a>
          </div>
        ) : (
          <form method="post" action="/api/auth/verify" className="stack">
            <h1>Confirm sign in</h1>
            <p className="muted">Tap the button to finish signing in on this device.</p>
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="btn btn-primary btn-block">Sign in</button>
          </form>
        )}
      </div>
    </main>
  );
}
