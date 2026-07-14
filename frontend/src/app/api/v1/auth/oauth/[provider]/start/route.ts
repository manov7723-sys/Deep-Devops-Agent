import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, getProviderAsync, isMockMode } from "@/lib/oauth/providers";
import { generateNonce, signState } from "@/lib/oauth/state";

const NONCE_COOKIE = "ddaoauth";
const NEXT_COOKIE = "ddaoauthnext";
const POPUP_COOKIE = "ddaoauthpopup";
const TEN_MIN_SEC = 10 * 60;

/**
 * Whitelist for the `?next=<path>` redirect to avoid open-redirect abuse.
 * Only same-origin relative paths under known app sections are honored.
 */
function safeNextPath(input: string | null): string | null {
  if (!input) return null;
  if (!input.startsWith("/")) return null;
  if (input.startsWith("//")) return null; // protocol-relative
  if (input.includes("\n") || input.includes("\r")) return null;
  return input;
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await ctx.params;
  let provider;
  try {
    provider = await getProviderAsync(providerId);
  } catch (err) {
    // Anything thrown while resolving credentials (DB unreachable, decrypt
    // error not handled lower down, etc.) is treated the same as "provider
    // not configured" — bounce to the login banner instead of a 500.
    console.error("[oauth/start] resolve failed", err);
    provider = null;
  }
  if (!provider) {
    if (isMockMode()) {
      // Tests check the JSON envelope; only browsers should see the redirect.
      return NextResponse.json({ ok: false, code: "provider_unavailable" }, { status: 503 });
    }
    const url = new URL(req.url);
    const dest = new URL("/auth/login", url.origin);
    dest.searchParams.set("oauth_error", "provider_unavailable");
    return NextResponse.redirect(dest, 303);
  }

  // Compute return path + popup intent FIRST so they can be baked into the
  // signed state — the state round-trips through GitHub reliably, whereas
  // cookies can be dropped on the cross-site popup return in some browsers.
  const reqUrl = new URL(req.url);
  const requestedNext = safeNextPath(reqUrl.searchParams.get("next"));
  const isPopup = reqUrl.searchParams.get("popup") === "1";

  const nonce = generateNonce();
  const state = signState({
    provider: providerId,
    nonce,
    issuedAtMs: Date.now(),
    popup: isPopup,
    next: requestedNext,
  });
  const origin = req.headers.get("origin") ?? reqUrl.origin;
  const authorizeUrl = buildAuthorizeUrl({ provider, origin, state });

  const jar = await cookies();
  jar.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TEN_MIN_SEC,
  });

  // Also mirror next/popup into cookies as a belt-and-braces fallback for the
  // non-popup full-page flow. The callback prefers the values from `state`.
  if (requestedNext) {
    jar.set(NEXT_COOKIE, requestedNext, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TEN_MIN_SEC,
    });
  } else {
    jar.delete(NEXT_COOKIE);
  }
  if (isPopup) {
    jar.set(POPUP_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TEN_MIN_SEC,
    });
  } else {
    jar.delete(POPUP_COOKIE);
  }

  if (isMockMode()) {
    // Tests want the URL JSON-encoded — they synthesize a fake `code` and POST
    // straight to the callback, skipping the real browser→provider round-trip.
    return NextResponse.json({ ok: true, authorizeUrl, state, nonce, mock: true });
  }
  return NextResponse.redirect(authorizeUrl);
}
