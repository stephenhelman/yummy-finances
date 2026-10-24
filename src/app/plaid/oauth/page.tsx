import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { OAuthResume } from "./oauth-resume";

export const metadata: Metadata = { title: "Finishing bank connection" };

// Where an OAuth bank sends the user back to. Must match PLAID_REDIRECT_URI and be registered in the
// Plaid Dashboard. Signed-out visitors are sent to /login (the session cookie survives the bank redirect).
export default async function PlaidOAuthPage() {
  await requireAdmin();
  return (
    <main className="container page">
      <OAuthResume />
    </main>
  );
}
