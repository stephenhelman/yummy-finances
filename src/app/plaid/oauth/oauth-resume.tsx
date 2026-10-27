"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { clearLink, parseLink, readRawLink } from "@/components/plaid-storage";

type Outcome = null | "saving" | "cancelled" | "failed" | "duplicate" | "busy";

// Browser-only values, read through useSyncExternalStore so server and first client render agree
// (both see "undefined" = not read yet) and nothing is set inside an effect.
const noSubscribe = () => () => {};
const useBrowserValue = <T,>(read: () => T) => useSyncExternalStore(noSubscribe, read, () => undefined);

/**
 * Re-opens Plaid Link after the bank's OAuth redirect: the SAME link token, plus the full return URL as
 * receivedRedirectUri. Then runs the same finishing step as the normal flow (exchange for a new
 * connection, re-check for a reconnect) and goes back to Connections.
 */
export function OAuthResume() {
  const router = useRouter();
  const raw = useBrowserValue(readRawLink); // undefined until in the browser, then string | null
  const href = useBrowserValue(() => window.location.href);
  const stored = parseLink(raw);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const opened = useRef(false);

  const onSuccess = useCallback(
    async (publicToken: string | null, metadata?: { institution?: { institution_id?: string } | null }) => {
      if (!stored) return;
      setOutcome("saving");
      const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      // Connect exchanges the public token; reconnect (update mode) has nothing to exchange.
      const r =
        stored.mode === "connect"
          ? publicToken
            ? await fetch("/api/plaid/exchange", json({ public_token: publicToken, institution_id: metadata?.institution?.institution_id }))
            : null
          : await fetch("/api/plaid/reconnect", json({ item_id: stored.itemId }));
      clearLink();
      if (r?.ok) {
        router.replace("/admin/connections");
        return;
      }
      const err = ((await r?.json().catch(() => null)) as { error?: string } | null)?.error;
      setOutcome(err === "institution_already_connected" ? "duplicate" : err === "connect_in_progress" ? "busy" : "failed");
    },
    [stored, router],
  );

  const { open, ready } = usePlaidLink({
    token: stored?.token ?? null,
    receivedRedirectUri: href,
    onSuccess,
    onExit: () => {
      // Plaid's hook also calls this when its handler is torn down without Link ever opening.
      if (!opened.current) return;
      clearLink();
      if (stored?.mode === "connect") void fetch("/api/plaid/link-token", { method: "DELETE" }).catch(() => undefined); // free the in-flight slot
      setOutcome((o) => (o === "saving" ? o : "cancelled"));
    },
  });

  const waiting = outcome === null && raw !== undefined && !!stored;
  useEffect(() => {
    if (waiting && ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [waiting, ready, open]);

  if (outcome === null && (raw === undefined || stored)) {
    return (
      <section className="card" role="status">
        <h1>Finishing your bank connection…</h1>
        <p className="muted">One moment. Please don&rsquo;t close this page.</p>
      </section>
    );
  }
  if (outcome === "saving") {
    return (
      <section className="card" role="status">
        <h1>Saving your bank connection…</h1>
        <p className="muted">One moment. Please don&rsquo;t close this page.</p>
      </section>
    );
  }

  const messages = {
    missing: { title: "This connection can't be finished here", body: "The connection started in a different tab or browser, or the saved session was cleared. Please start again from Connections." },
    cancelled: { title: "Bank connection cancelled", body: "Nothing was changed. You can try again from Connections." },
    duplicate: { title: "That bank is already connected", body: "Nothing was added. You can see it on Connections, or add a different bank." },
    busy: { title: "Another bank connection is in progress", body: "Nothing was changed. Finish or close the other one, then try again from Connections." },
    failed: { title: "Couldn't save the connection", body: "The bank approved it, but saving failed. Nothing was changed. Try again from Connections." },
  } as const;
  const m = messages[outcome ?? "missing"];
  return (
    <section className="card" role="alert">
      <h1>{m.title}</h1>
      <p>{m.body}</p>
      <a className="btn btn-primary" href="/admin/connections">Back to Connections</a>
    </section>
  );
}
