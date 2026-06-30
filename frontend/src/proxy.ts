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

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /u/*, /p/*, /admin/* all require an active session cookie. The layout
  // server checks (getActiveSession / requireSuperAdmin) verify validity +
  // role beyond mere presence.
  if (
    pathname.startsWith("/u/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/admin")
  ) {
    const cookie = req.cookies.get(SESS_COOKIE)?.value;
    if (!cookie) {
      const url = new URL("/auth/login", req.url);
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
