"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SyncSummary } from "@/lib/sync-summary";

export function SyncNowButton({ last }: { last: SyncSummary | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(last);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync-now", { method: "POST" });
      const body = (await res.json()) as { summary?: SyncSummary; message?: string };
      if (!res.ok || !body.summary) setError(body.message ?? "The sync didn't finish.");
      else setSummary(body.summary);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. The sync may still be running. Check again in a minute.");
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? "Syncing… keep this page open" : "Sync now"}
      </button>
      {busy ? <p className="small muted">The first sync can take a few minutes.</p> : null}
      {error ? <p role="alert" className="small" style={{ color: "var(--bad)" }}>{error}</p> : null}
      {summary && !busy ? (
        <div className={`alert ${summary.ok ? "alert-ok" : "alert-warn"}`} role="status">
          <strong>{summary.ok ? "Last sync" : "Last sync had a problem"} · {summary.atLabel}</strong>
          {summary.lines.map((l) => (
            <p key={l} className="small">{l}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
