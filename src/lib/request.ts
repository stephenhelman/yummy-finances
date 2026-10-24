/** CSRF defence for cookie-authenticated JSON POST routes: the Origin header must match this server. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}
