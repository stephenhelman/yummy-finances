/** CSRF defence for cookie-authenticated JSON POST routes: the Origin header must match this server. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}

/** The `item_id` of a JSON body (which bank the call is about), or null if absent. */
export async function itemIdFrom(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { item_id?: unknown } | null;
  return typeof body?.item_id === "string" && body.item_id ? body.item_id : null;
}
