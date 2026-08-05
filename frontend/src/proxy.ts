import { NextResponse, type NextRequest } from "next/server";

/**
 * Coarse edge-runtime gate. We can't hit Postgres from the edge, so this only
 * checks for the presence of the active session cookie — actual authorisation
 * (Prisma session lookup, super-admin flag, project membership) lives in the
 * per-area `layout.tsx` server components.
 *
 * The cookie value is an OPAQUE 32-byte token (Phase 1 redesign). Previous
 * iterations base64-encoded a JSON payload here; that format is gone, so don't
 * try to decode the cookie body.
 */
const SESS_COOKIE = process.env.SESSION_COOKIE_NAME ?? "ddasess";

/**
 * The origin the BROWSER used, not the one the pod sees.
 *
 * WHY THIS EXISTS (2026-08 incident): `new URL(path, req.url)` looked correct
 * and was the single worst bug in the deployment. Behind an ALB/ELB, Next.js
 * rebuilds req.url from the container's own listen address, so its origin is
 * "http://localhost:3000". Every unauthenticated request to /u/*, /p/* or
 * /admin/* was therefore 303'd to *the user's own laptop* — a machine that,
 * for anyone running the app locally too, answers on that port with a
 * different installation and a different database.
 *
 * The symptom was "the deployed app redirects me to localhost", and it
 * survived rebuilding OAuth apps, rotating client secrets, correcting callback
 * URLs and setting APP_PUBLIC_URL — none of which touch this line. It fires on
 * far more requests than the OAuth callback does, which is why switching
 * browsers never helped either.
 *
 * Order of trust:
 *   1. APP_PUBLIC_URL          — explicit, wins when set
 *   2. X-Forwarded-Host/Proto  — what ALB/ELB/nginx/Cloudflare set to the real
 *                                client-facing host
 *   3. Host header             — direct exposure with no proxy
 *   4. req.url                 — last resort (correct in local dev)
 * Loopback hosts are rejected as a source: they can only ever be the pod
 * talking about itself.
 *
 * Inlined rather than imported from lib/auth/cookie-security so nothing drags
 * a Node-only dependency into the edge runtime this middleware runs in.
 */
function browserOrigin(req: NextRequest): string {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
      return new URL(withScheme).origin;
    } catch {
      /* malformed — fall through to headers */
    }
  }

  const fwdHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = fwdHost || req.headers.get("host")?.trim();
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/i.test(host)) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (req.nextUrl.protocol === "https:" ? "https" : "http");
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      /* unparseable — fall through */
    }
  }

  return req.nextUrl.origin;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /u/*, /p/*, /admin/* all require an active session cookie. The layout
  // server checks (getActiveSession / requireSuperAdmin) verify validity +
  // role beyond mere presence.
  if (pathname.startsWith("/u/") || pathname.startsWith("/p/") || pathname.startsWith("/admin")) {
    const cookie = req.cookies.get(SESS_COOKIE)?.value;
    if (!cookie) {
      // browserOrigin, NOT req.url — see the comment above.
      const url = new URL("/auth/login", browserOrigin(req));
      // Preserve where they were headed so the post-login flow can bounce back.
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/u/:path*", "/p/:path*"],
};
