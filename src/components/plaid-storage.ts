// Plaid OAuth: the bank sends the user back to /plaid/oauth, where Link must be re-opened with the SAME
// link token. It is kept in sessionStorage (this tab only) while Link is open. Storage can be unavailable
// (private mode, blocked), so every access is guarded and the app works without it.

const KEY = "yf_plaid_link";

export type StoredLink = { token: string; mode: "connect" | "reconnect" };

export function saveLink(link: StoredLink): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(link));
  } catch {
    /* OAuth return will ask the user to start again */
  }
}

/** The raw saved value (a string snapshot, so it works with useSyncExternalStore), or null. */
export function readRawLink(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function parseLink(raw: string | null | undefined): StoredLink | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredLink>;
    if (typeof v.token === "string" && (v.mode === "connect" || v.mode === "reconnect")) return { token: v.token, mode: v.mode };
  } catch {
    /* fall through */
  }
  return null;
}

export function clearLink(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
