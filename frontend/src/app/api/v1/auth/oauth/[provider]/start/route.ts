import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, getProviderAsync, isMockMode } from "@/lib/oauth/providers";
import { generateNonce, newPkcePair, signState } from "@/lib/oauth/state";
import { authCookieSecure, publicOrigin } from "@/lib/auth/cookie-security";

const NONCE_COOKIE = "ddaoauth";
const NEXT_COOKIE = "ddaoauthnext";
const POPUP_COOKIE = "ddaoauthpopup";
/** PKCE verifier. httpOnly — it is a secret and must never reach the browser's
 *  URL bar or the provider. Only its SHA-256 challenge goes on the wire. */
const PKCE_COOKIE = "ddaoauthpkce";
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
    // publicOrigin, NOT url.origin — behind a proxy the latter is the pod's
    // own address (http://localhost:3000), which would bounce the user to
    // their own machine. See the comment on failureResponse in ./callback.
    const dest = new URL("/auth/login", publicOrigin(url.origin, req.headers));
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
  // APP_PUBLIC_URL wins over anything inferred from the request. Behind an
  // ALB/ELB the inferred value is the proxy's or pod's view — and `Origin` is
  // absent entirely on top-level GET navigations — so a deployed app can end
  // up sending redirect_uri=http://localhost:3000/... The provider then bounces
  // the user to localhost, which has no nonce cookie for that flow, and the
  // callback fails with `missing_nonce` on a page that isn't even the app they
  // started from.
  const origin = publicOrigin(req.headers.get("origin") ?? reqUrl.origin, req.headers);

  // REFUSE to start a flow that would send a loopback redirect_uri from a
  // production deployment.
  //
  // WHY (2026-08 incident): behind an ALB/ELB, Next.js rebuilds req.url from
  // the pod's own listen address, so `new URL(req.url).origin` is
  // "http://localhost:3000" — the container's internal address, not the public
  // one. With APP_PUBLIC_URL unset, publicOrigin() falls back to that and the
  // deployed app asks the provider to redirect to localhost. If the OAuth app
  // ALSO has a localhost callback registered (very common — it was added for
  // local development), the provider considers it valid, accepts the flow, and
  // sends the user to their OWN laptop. Nothing errors: no redirect_uri
  // mismatch, no failed exchange, no log line. The user lands on a different
  // installation of the app and cannot tell why sign-in "did nothing".
  //
  // Failing here converts hours of invisible misdirection into one sentence
  // naming the exact env var to set.
  if (process.env.NODE_ENV === "production" && !process.env.APP_PUBLIC_URL?.trim()) {
    const host = (() => {
      try {
        return new URL(origin).hostname;
      } catch {
        return "";
      }
    })();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
      console.error(
        `[oauth/start] REFUSING to start ${providerId} sign-in: APP_PUBLIC_URL is not set, so the redirect_uri would be ${origin}/api/v1/auth/oauth/${providerId}/callback — the pod's own address. Set APP_PUBLIC_URL to the URL users actually visit, then retry.`,
      );
      if (isMockMode()) {
        return NextResponse.json({ ok: false, code: "app_public_url_unset" }, { status: 503 });
      }
      const dest = new URL("/auth/login", publicOrigin(reqUrl.origin, req.headers));
      dest.searchParams.set("oauth_error", "app_public_url_unset");
      return NextResponse.redirect(dest, 303);
    }
  }

  const pkce = newPkcePair();
  const authorizeUrl = buildAuthorizeUrl({
    provider,
    origin,
    state,
    codeChallenge: pkce.challenge,
  });

  // Log the EXACT redirect_uri + client_id we're about to send. A provider
  // rejecting the flow ("redirect_uri is not associated with this
  // application", "invalid_client") tells you nothing about which value was
  // wrong, and the two most common causes are invisible from the browser:
  //   • APP_PUBLIC_URL unset behind a proxy → we send the pod/localhost origin
  //     instead of the public one the OAuth App has registered
  //   • the same OAuth App reused across environments — it can only carry ONE
  //     callback URL, so whichever env isn't registered always fails
  // Printing both here turns "it redirects to the home page" into a one-line
  // diff against the provider's settings page. (2026-08 incident.)
  console.log(
    `[oauth/start] provider=${providerId} client_id=${provider.clientId} redirect_uri=${origin}/api/v1/auth/oauth/${providerId}/callback app_public_url=${process.env.APP_PUBLIC_URL ?? "(unset — inferred from request)"}`,
  );

  const jar = await cookies();
  jar.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieSecure(),
    path: "/",
    maxAge: TEN_MIN_SEC,
  });
  jar.set(PKCE_COOKIE, pkce.verifier, {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieSecure(),
    path: "/",
    maxAge: TEN_MIN_SEC,
  });

  // Also mirror next/popup into cookies as a belt-and-braces fallback for the
  // non-popup full-page flow. The callback prefers the values from `state`.
  if (requestedNext) {
    jar.set(NEXT_COOKIE, requestedNext, {
      httpOnly: true,
      sameSite: "lax",
      secure: authCookieSecure(),
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
      secure: authCookieSecure(),
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
