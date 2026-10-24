"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { clearLink, saveLink } from "@/components/plaid-storage";

type Mode = "connect" | "reconnect";

const TOKEN_URL: Record<Mode, string> = {
  connect: "/api/plaid/link-token",
  reconnect: "/api/plaid/link-token/update",
};

const TOKEN_ERRORS: Record<string, string> = {
  already_connected: "A bank is already connected.",
  item_unusable: "This bank connection can't be used in this environment.",
  redirect_uri_problem: "The bank return address isn't registered with Plaid yet. See DEPLOY.md, step 1.",
};

export function ConnectButton({ mode = "connect", label }: { mode?: Mode; label?: string }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(TOKEN_URL[mode], { method: "POST" })
      .then(async (r) => {
        const body = (await r.json()) as { link_token?: string; error?: string; message?: string };
        if (cancelled) return;
        if (body.link_token) setToken(body.link_token);
        else setError(body.message ?? TOKEN_ERRORS[body.error ?? ""] ?? "Couldn't start the bank connection. Try again in a moment.");
      })
      .catch(() => !cancelled && setError("Couldn't start the bank connection. Check your internet and try again."));
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const onSuccess = useCallback(
    async (publicToken: string | null) => {
      setSaving(true);
      clearLink();
      // Connect exchanges the public token. Reconnect (update mode) has nothing to exchange.
      const r =
        mode === "connect"
          ? publicToken
            ? await fetch("/api/plaid/exchange", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ public_token: publicToken }),
              })
            : null
          : await fetch("/api/plaid/reconnect", { method: "POST" });
      if (r?.ok) router.refresh();
      else {
        setError(mode === "connect" ? "Connecting failed. Nothing was saved." : "Reconnecting didn't finish. Try again.");
        setSaving(false);
      }
    },
    [mode, router],
  );

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit: () => clearLink() });
  const text = label ?? (mode === "connect" ? "Connect your bank" : "Reconnect your bank");

  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ready || saving}
        onClick={() => {
          // Banks that use OAuth send the user away and back; Link must be re-opened with this same token.
          if (token) saveLink({ token, mode });
          open();
        }}
      >
        {saving ? "Saving…" : text}
      </button>
      {error ? <p role="alert" className="small" style={{ color: "var(--bad)" }}>{error}</p> : null}
    </div>
  );
}

export function CheckHealthButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/plaid/health", { method: "POST" });
        router.refresh();
        setBusy(false);
      }}
    >
      {busy ? "Checking…" : "Check connection"}
    </button>
  );
}
