"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { clearLink, saveLink } from "@/components/plaid-storage";

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

const TOKEN_ERRORS: Record<string, string> = {
  connect_in_progress: "Another bank connection is still open. Finish or close it first, then try again.",
  item_unusable: "This bank connection can't be used in this environment.",
  redirect_uri_problem: "The bank return address isn't registered with Plaid yet. See DEPLOY.md, step 1.",
};

type Props = { label?: string } & ({ mode?: "connect" } | { mode: "reconnect"; itemId: string });

/**
 * Connect: the link token is requested when the button is clicked (it marks a connection as in
 * flight, so it must not be fetched just by viewing the page). Reconnect (update mode) is for one
 * bank: its token is fetched up front and nothing is exchanged afterwards.
 */
export function ConnectButton(props: Props) {
  const router = useRouter();
  const mode = props.mode ?? "connect";
  const itemId = props.mode === "reconnect" ? props.itemId : null;
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const opened = useRef(false);
  const wantOpen = useRef(false); // open Link as soon as the token just requested is ready

  /** A link token, or the message to show instead. */
  const fetchToken = useCallback(async (): Promise<{ token: string } | { error: string }> => {
    try {
      const r = await (mode === "connect" ? post("/api/plaid/link-token") : post("/api/plaid/link-token/update", { item_id: itemId }));
      const body = (await r.json()) as { link_token?: string; error?: string; message?: string };
      if (body.link_token) return { token: body.link_token };
      return { error: body.message ?? TOKEN_ERRORS[body.error ?? ""] ?? "Couldn't start the bank connection. Try again in a moment." };
    } catch {
      return { error: "Couldn't start the bank connection. Check your internet and try again." };
    }
  }, [mode, itemId]);

  useEffect(() => {
    if (mode !== "reconnect") return;
    let cancelled = false;
    void fetchToken().then((t) => {
      if (cancelled) return;
      if ("token" in t) setToken(t.token);
      else setError(t.error);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, fetchToken]);

  const onSuccess = useCallback(
    async (publicToken: string | null, metadata?: { institution?: { institution_id?: string } | null }) => {
      opened.current = false;
      setSaving(true);
      clearLink();
      // Connect exchanges the public token. Reconnect (update mode) has nothing to exchange.
      const r =
        mode === "connect"
          ? publicToken
            ? await post("/api/plaid/exchange", { public_token: publicToken, institution_id: metadata?.institution?.institution_id })
            : null
          : await post("/api/plaid/reconnect", { item_id: itemId });
      if (r?.ok) {
        setToken(null);
        router.refresh();
        setSaving(false);
        return;
      }
      const body = (await r?.json().catch(() => null)) as { error?: string; institution?: string | null } | null;
      if (body?.error === "institution_already_connected") setError(`${body.institution ?? "That bank"} is already connected. Nothing was added.`);
      else if (body?.error === "connect_in_progress") setError(TOKEN_ERRORS.connect_in_progress);
      else setError(mode === "connect" ? "Connecting failed. Nothing was saved." : "Reconnecting didn't finish. Try again.");
      setToken(null);
      setSaving(false);
    },
    [mode, itemId, router],
  );

  const onExit = useCallback(() => {
    // Plaid's hook also calls this when its handler is torn down without Link ever opening.
    if (!opened.current) return;
    opened.current = false;
    clearLink();
    if (mode === "connect") {
      setToken(null); // a link token is single-use; the next click asks for a fresh one
      void fetch("/api/plaid/link-token", { method: "DELETE" }).catch(() => undefined); // free the in-flight slot
    }
  }, [mode]);

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });

  const launch = useCallback(() => {
    if (!token) return;
    // Banks that use OAuth send the user away and back; Link must be re-opened with this same token.
    saveLink(mode === "connect" ? { token, mode } : { token, mode, itemId: itemId! });
    opened.current = true;
    open();
  }, [token, mode, itemId, open]);

  useEffect(() => {
    if (wantOpen.current && token && ready) {
      wantOpen.current = false;
      launch();
    }
  }, [token, ready, launch]);

  async function onClick() {
    setError(null);
    if (token) return launch();
    setStarting(true);
    const t = await fetchToken();
    if ("token" in t) {
      wantOpen.current = true;
      setToken(t.token);
    } else setError(t.error);
    setStarting(false);
  }

  const text = props.label ?? (mode === "connect" ? "Connect your bank" : "Reconnect your bank");
  const disabled = saving || starting || (mode === "reconnect" && (!ready || !token));

  return (
    <div className="stack">
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={onClick}>
        {saving ? "Saving…" : starting ? "Starting…" : text}
      </button>
      {error ? <p role="alert" className="small" style={{ color: "var(--bad)" }}>{error}</p> : null}
    </div>
  );
}

export function CheckHealthButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post("/api/plaid/health", { item_id: itemId });
        router.refresh();
        setBusy(false);
      }}
    >
      {busy ? "Checking…" : "Check connection"}
    </button>
  );
}
