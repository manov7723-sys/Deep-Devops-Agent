/**
 * One source of truth for the `Secure` flag on auth cookies.
 *
 * WHY THIS EXISTS (2026-07 incident, twice):
 * `secure: process.env.NODE_ENV === "production"` was copy-pasted into both
 * the session store and the OAuth start route. Browsers REFUSE to store a
 * Secure cookie delivered over plain HTTP, and our deployed app sits behind a
 * Classic ELB / ALB on port 80 with no TLS terminator. The result is a
 * cookie that is set by the server, silently dropped by the browser, and
 * missing on the next request — with no error anywhere:
 *
 *   • session cookie dropped → login "succeeds", next request is 401,
 *     2FA setup loops on "Sign in again to set up two-factor"
 *   • OAuth nonce/state cookie dropped → callback has nothing to verify,
 *     redirects to /auth/login?oauth_error=missing_nonce
 *
 * Both symptoms point at expired sessions, so the actual cause (no TLS) is
 * nearly impossible to guess from the UI.
 *
 * Set SESSION_COOKIE_SECURE=false for HTTP-only deployments; remove it the
 * moment TLS is in front (ACM + ALB, or Cloudflare).
 */

/**
 * Precedence:
 *   1. SESSION_COOKIE_SECURE=false → force OFF (HTTP-behind-LB deployments)
 *   2. SESSION_COOKIE_SECURE=true  → force ON  (HTTPS proxy where NODE_ENV lies)
 *   3. fallback: ON when NODE_ENV === "production"
 */
export function authCookieSecure(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return true;
  return process.env.NODE_ENV === "production";
}

/**
 * The origin the browser actually reached us on — used to build OAuth
 * redirect_uri values and post-login redirects.
 *
 * WHY NOT just trust the request: behind an ALB/ELB the app sees the proxy's
 * view of the request, and `Origin` is absent entirely on top-level GET
 * navigations (browsers only send it for CORS/POST). Inferring the origin from
 * headers therefore produces `http://localhost:3000` or a pod IP in exactly
 * the deployment where getting it right matters most — and an OAuth provider
 * then sends the user to a callback that isn't the app they started from.
 *
 * APP_PUBLIC_URL removes the guesswork. Set it to the URL users actually type.
 *
 * @param fallbackOrigin origin derived from the request, used when unset
 */
export function publicOrigin(fallbackOrigin: string): string {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (!configured) return fallbackOrigin;
  try {
    // Normalise: accept "https://app.example.com/" or a bare host.
    const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
    return new URL(withScheme).origin;
  } catch {
    return fallbackOrigin;
  }
}
