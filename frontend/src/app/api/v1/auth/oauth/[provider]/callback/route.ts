import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { OAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";
import { getProviderAsync, isMockMode } from "@/lib/oauth/providers";
import { verifyState } from "@/lib/oauth/state";
import { exchange } from "@/lib/oauth/exchange";
import { resolveIdentity } from "@/lib/oauth/resolve";
import { createPendingSession, getActiveSession } from "@/lib/auth/session";
import { extractRequestMeta } from "@/lib/auth/request-meta";
import { audit } from "@/lib/audit/log";
import { authCookieSecure, publicOrigin } from "@/lib/auth/cookie-security";

const NONCE_COOKIE = "ddaoauth";
const NEXT_COOKIE = "ddaoauthnext";
const POPUP_COOKIE = "ddaoauthpopup";
/** PKCE verifier set at /start — proves this callback belongs to that flow. */
const PKCE_COOKIE = "ddaoauthpkce";

/**
 * HTML response for popup-mode OAuth: notify the opener window (the wizard) and
 * close the popup, so the main page never navigates (no redirect to home).
 *
 * Broadcasts on BOTH channels — postMessage AND a localStorage event — because
 * modern browsers (Chrome COOP) sever `window.opener` on cross-origin
 * navigation, which silently swallows postMessage. The localStorage 'storage'
 * event still fires cross-tab and gives the wizard a reliable signal.
 *
 * Body text intentionally does not include the word "home" or any redirect —
 * the popup must never navigate the opener or fall back to the dashboard.
 */
function popupClose(
  status: "connected" | "needs_login" | "error",
  detail?: { code?: string; message?: string },
): NextResponse {
  const bodyText =
    status === "connected"
      ? "Connected. You can close this window."
      : status === "needs_login"
        ? "Please sign in to the app first, then close this window and reconnect."
        : `Sign-in failed${detail?.message ? `: ${detail.message}` : ""}. You can close this window.`;
  const msg = { source: "dda-oauth", status, ts: Date.now(), ...(detail ?? {}) };
  const html = `<!doctype html><meta charset="utf-8"><title>GitHub</title>
<body style="font:14px system-ui;padding:24px;color:#444">${bodyText.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string)}</body>
<script>
(function () {
  var msg = ${JSON.stringify(msg)};
  try { if (window.opener) window.opener.postMessage(msg, window.location.origin); } catch (e) {}
  try { localStorage.setItem("dda_github_oauth_result", JSON.stringify(msg)); } catch (e) {}
  try { window.close(); } catch (e) {}
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * Return HTML that finishes the OAuth attach in the popup OR full-page tab.
 *
 * The old logic relied on `window.opener` to decide popup vs full-page, but
 * modern browsers sever `window.opener` on cross-origin navigation (COOP),
 * turning the popup into a "not a popup" from JS's POV. It then fell back to
 * `window.location.replace(next)` — but if `nextPath` was missing for any
 * reason it landed on the dashboard, silently breaking the wizard.
 *
 * New logic — ALWAYS do all of these:
 *   1. Broadcast the "connected" signal via BOTH postMessage AND localStorage
 *      (localStorage 'storage' event fires cross-tab even when opener is
 *      severed — the wizard listens for both). See CreateProjectWizard.tsx.
 *   2. Attempt `window.close()`. It's allowed because we (script) opened the
 *      window; browsers permit close even when opener is null.
 *   3. If the window is still alive after 300ms, do `window.location.replace`
 *      back to `nextPath` (or the wizard resume URL — never the dashboard,
 *      which throws away the user's in-progress work).
 */
function smartReturn(nextPath: string | null): NextResponse {
  // NEVER default to /u/dashboard on a null next — that discards wizard state.
  // A generic OAuth attach without a next path (e.g. from the account page)
  // was originally the caller's responsibility to pass; when absent we send
  // the user to the projects list, which is the safest continuation.
  const safe = nextPath && nextPath.startsWith("/") ? nextPath : "/u/projects";
  const html = `<!doctype html><meta charset="utf-8"><title>GitHub</title>
<body style="font:14px system-ui;padding:24px;color:#444">Finishing GitHub connection…</body>
<script>
(function () {
  var next = ${JSON.stringify(safe)};
  var msg = { source: "dda-oauth", status: "connected", ts: Date.now() };
  // Broadcast on every channel we can — the wizard's listener handles both.
  try { if (window.opener) window.opener.postMessage(msg, window.location.origin); } catch (e) {}
  try { localStorage.setItem("dda_github_oauth_result", JSON.stringify(msg)); } catch (e) {}
  // Try to close unconditionally. Windows opened via script can close even
  // when their opener has been severed by COOP.
  try { window.close(); } catch (e) {}
  // If we're still here after 300ms, we're a full-page tab, not a popup — go
  // to the wizard resume URL so the user picks up where they were.
  setTimeout(function () {
    try { window.location.replace(next); } catch (e) {}
  }, 300);
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await ctx.params;
  const url = new URL(req.url);
  // Detect popup mode BEFORE any early-return. Every failure path needs to
  // know it's inside a popup so it can close it instead of navigating the
  // window — otherwise the popup follows a 303 to /auth/login and the
  // (guest)/layout then bounces it to /u/dashboard for signed-in users,
  // which is why the popup used to end up showing the home page.
  const jar = await cookies();
  const popupCookie = jar.get(POPUP_COOKIE)?.value === "1";
  const provider = await getProviderAsync(providerId);
  if (!provider) {
    return failureResponse("provider_unavailable", "OAuth provider isn't configured.", url, req.headers, undefined, popupCookie);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const meta = extractRequestMeta(req);

  if (providerError) {
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, providerError },
    });
    return failureResponse("provider_error", "The provider rejected the sign-in.", url, req.headers, undefined, popupCookie);
  }
  if (!code || !state) {
    return failureResponse("missing_params", "Missing code or state.", url, req.headers, undefined, popupCookie);
  }

  const nonce = jar.get(NONCE_COOKIE)?.value;
  if (!nonce) {
    return failureResponse("missing_nonce", "Sign-in state expired. Try again.", url, req.headers, undefined, popupCookie);
  }
  const verified = verifyState(state, nonce);
  if (!verified.ok) {
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, reason: verified.code },
    });
    return failureResponse(verified.code, "Sign-in state could not be verified.", url, req.headers, undefined, popupCookie);
  }
  if (verified.provider !== providerId) {
    return failureResponse("provider_mismatch", "Sign-in state is for a different provider.", url, req.headers, undefined, popupCookie);
  }
  // Popup mode is authoritative from the SIGNED state once verified; fall back
  // to the cookie for the pre-verify failure paths above.
  const isPopupFlow = verified.popup || popupCookie;

  // Single-use: clear the nonce as soon as it's been spent.
  jar.delete(NONCE_COOKIE);

  // MUST match the origin used at /start — the provider compares the
  // redirect_uri on the token exchange against the one from the authorize
  // request, and a mismatch fails with redirect_uri_mismatch.
  const origin = publicOrigin(req.headers.get("origin") ?? url.origin, req.headers);
  // Single-use, like the nonce: spend the PKCE verifier whether or not the
  // exchange succeeds, so a replayed callback can't reuse it.
  const codeVerifier = jar.get(PKCE_COOKIE)?.value;
  jar.delete(PKCE_COOKIE);
  const ex = await exchange(provider, code, origin, codeVerifier);
  if (!ex.ok) {
    const redirectUri = `${origin}/api/v1/auth/oauth/${providerId}/callback`;
    // Record WHICH redirect_uri + client_id were rejected. `invalid_client`
    // and `redirect_uri_mismatch` are indistinguishable from the browser, and
    // both have the same two root causes: a stale client secret, or the same
    // OAuth App reused across environments (one app = one callback URL, so
    // whichever env isn't registered always fails). See [oauth/start] for the
    // matching outbound log. (2026-08 incident.)
    console.error(
      `[oauth/callback] EXCHANGE FAILED provider=${providerId} reason=${ex.code} client_id=${provider.clientId} redirect_uri=${redirectUri} app_public_url=${process.env.APP_PUBLIC_URL ?? "(unset — inferred from request)"} — verify this exact redirect_uri is the Authorization callback URL on the provider's app settings, and that the client secret in this environment is the CURRENT one.`,
    );
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        provider: providerId,
        reason: ex.code,
        message: ex.message,
        redirectUri,
        clientId: provider.clientId,
      },
    });
    return failureResponse(ex.code, ex.message, url, req.headers, redirectUri, isPopupFlow);
  }

  // Attach-to-current-user mode. When the caller is already signed in (e.g.
  // the project-create wizard "Connect GitHub" button), we attach the OAuth
  // credential to their existing account instead of switching them to the
  // provider-identified user. Lets a password-signed-in user grant repo
  // access without losing their session.
  const activeSess = await getActiveSession();
  // Prefer the values carried inside the signed state — they round-trip through
  // GitHub reliably. Cookies are only a fallback for the legacy full-page flow.
  const nextPath = verified.next ?? jar.get(NEXT_COOKIE)?.value ?? null;
  jar.delete(NEXT_COOKIE);
  const isPopup = isPopupFlow;
  jar.delete(POPUP_COOKIE);
  if (activeSess) {
    const conflict = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: providerId as OAuthProvider,
          providerAccountId: ex.profile.providerAccountId,
        },
      },
      select: { userId: true },
    });
    if (conflict && conflict.userId !== activeSess.userId) {
      await audit({
        userId: activeSess.userId,
        action: "auth.oauth.failed",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { provider: providerId, reason: "already_linked_to_other_user" },
      });
      return failureResponse(
        "already_linked",
        "That GitHub account is already linked to a different DeepAgent user.",
        url,
        req.headers,
        undefined,
        isPopupFlow,
      );
    }
    const accessTokenRef = encryptSecret(ex.profile.accessToken);
    const refreshTokenRef = ex.profile.refreshToken ? encryptSecret(ex.profile.refreshToken) : null;
    const linkedAccount = await prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider: providerId as OAuthProvider,
          providerAccountId: ex.profile.providerAccountId,
        },
      },
      create: {
        userId: activeSess.userId,
        provider: providerId as OAuthProvider,
        providerAccountId: ex.profile.providerAccountId,
        login: ex.profile.login || null,
        avatarUrl: ex.profile.avatarUrl ?? null,
        accessTokenRef,
        refreshTokenRef,
        tokenExpiresAt: ex.profile.expiresAt ?? null,
        scope: ex.profile.scope ?? null,
        providerBaseUrl: provider.baseUrl ?? null,
      },
      update: {
        login: ex.profile.login || null,
        avatarUrl: ex.profile.avatarUrl ?? null,
        accessTokenRef,
        refreshTokenRef,
        tokenExpiresAt: ex.profile.expiresAt ?? null,
        scope: ex.profile.scope ?? null,
        providerBaseUrl: provider.baseUrl ?? null,
      },
    });
    // Re-bind repos that lost their git identity. Disconnecting an account
    // nulls Repo.oauthAccountId (onDelete: SetNull), so reconnecting must
    // re-attach the owner's orphaned repos to this account — otherwise
    // connectedAs stays null and the agent can't authorize writes/PRs/MRs.
    // Scoped by provider so a GitLab reconnect only claims GitLab repos (and
    // vice-versa). Best-effort: a bind failure must never break the connect.
    if (providerId === "github" || providerId === "gitlab") {
      try {
        await prisma.repo.updateMany({
          where: {
            ownerId: activeSess.userId,
            oauthAccountId: null,
            deletedAt: null,
            provider: providerId,
          },
          data: { oauthAccountId: linkedAccount.id },
        });
      } catch {
        /* non-fatal — resolveTokenForRepo still falls back to this account */
      }
    }
    await audit({
      userId: activeSess.userId,
      action: "auth.oauth.linked",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, mode: "attach" },
    });
    if (isMockMode()) {
      return NextResponse.json({ ok: true, mode: "attach", linkedProvider: providerId });
    }
    // Return an HTML page that closes the popup (if we're in one) or redirects
    // (if a normal tab). Detected client-side via window.opener, so it never
    // bounces the main window to the home page. See smartReturn().
    console.log(
      `[oauth-callback:attach] provider=${providerId} nextPath=${JSON.stringify(nextPath)} isPopup=${isPopup} user=${activeSess.userId}`,
    );
    return smartReturn(nextPath);
  }

  const resolved = await resolveIdentity(
    providerId as OAuthProvider,
    ex.profile,
    provider.baseUrl ?? null,
  );
  if (!resolved.ok) {
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, reason: resolved.code, email: ex.profile.email },
    });
    return failureResponse(
      resolved.code,
      "The provider hasn't verified that email.",
      url,
      req.headers,
      undefined,
      isPopupFlow,
    );
  }

  const { outcome, user } = resolved.identity;

  // Forced TOTP for every OAuth sign-in too — provider auth ≠ MFA.
  await createPendingSession({
    userId: user.id,
    forcedTotpSetup: !user.twoFactorEnabled,
    rememberMe: true,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  await audit({
    userId: user.id,
    action:
      outcome === "signup"
        ? "auth.oauth.signup"
        : outcome === "linked"
          ? "auth.oauth.linked"
          : "auth.oauth.signin",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { provider: providerId, outcome },
  });

  // Mock mode returns JSON so the test harness can inspect; real flow follows
  // the standard browser redirect to /auth/2fa.
  if (isMockMode()) {
    return NextResponse.json({
      ok: true,
      outcome,
      needsTotp: true,
      setup: !user.twoFactorEnabled,
      userEmail: user.email,
    });
  }
  console.log(
    `[oauth-callback:new-user] provider=${providerId} nextPath=${JSON.stringify(nextPath)} isPopup=${isPopup} outcome=${outcome}`,
  );
  // Popup mode but no active app session (e.g. signed-out user used the popup):
  // we can't attach in place. Close the popup and tell the opener to fall back
  // to the normal full-page sign-in rather than showing 2FA inside the popup.
  if (isPopup) return popupClose("needs_login");
  // Preserve the requested next path through the TOTP gate so wizards
  // resume where they were after the user completes / skips 2FA.
  const totpDest = user.twoFactorEnabled ? "/auth/2fa" : "/auth/2fa?setup=1";
  const dest = nextPath
    ? `${totpDest}${totpDest.includes("?") ? "&" : "?"}next=${encodeURIComponent(nextPath)}`
    : totpDest;
  // `origin` (from publicOrigin) — NOT url.origin. See failureResponse below.
  return NextResponse.redirect(new URL(dest, origin));
}

/**
 * Build a failure response. In mock mode returns JSON for tests; otherwise
 * 303-redirects back to /auth/login carrying the failure code so the form can
 * render a human-readable message.
 *
 * The base origin MUST come from publicOrigin(), never from `new URL(req.url)`.
 *
 * WHY (2026-08 incident): behind an ALB/ELB, Next.js rebuilds req.url from the
 * pod's own listen address, so `url.origin` is "http://localhost:3000". Every
 * redirect built on it sent the user to THEIR OWN MACHINE at the end of an
 * otherwise-successful OAuth round-trip: the flow started on the deployed app,
 * authorised at GitHub, exchanged the code on the deployed app — and then
 * 303'd to localhost:3000/auth/login. Setting APP_PUBLIC_URL did not help,
 * because that value was only consulted when building `redirect_uri` for the
 * provider, not for these redirects. The result looked like "GitHub login
 * redirects me to localhost" with no error anywhere, and survived rebuilding
 * OAuth apps, rotating secrets and re-checking every callback URL.
 */
function failureResponse(
  code: string,
  message: string,
  requestUrl: URL,
  headers?: Headers,
  redirectUri?: string,
  isPopup?: boolean,
) {
  if (isMockMode()) {
    return NextResponse.json({ ok: false, code, message, redirectUri }, { status: 400 });
  }
  // Popup mode: never navigate. The popup was opened by the wizard (or the
  // per-project source-control page); redirecting it to /auth/login triggers
  // the (guest) layout's "already signed in → /u/dashboard" rule and the
  // popup ends up showing the Dashboard, which reads to the user as "OAuth
  // sent me to the home page." Instead, close the popup and hand the error
  // back to the opener via postMessage + localStorage.
  if (isPopup) {
    return popupClose("error", { code, message });
  }
  const dest = new URL("/auth/login", publicOrigin(requestUrl.origin, headers));
  dest.searchParams.set("oauth_error", code);
  // For the two failure codes whose cause is a config mismatch rather than a
  // user error, pass the redirect_uri we actually sent so the login page can
  // show it. Without this the user sees a generic "ask an admin" message with
  // nothing to compare against the provider's settings page.
  if (redirectUri && (code === "redirect_uri_mismatch" || code === "invalid_client")) {
    dest.searchParams.set("oauth_redirect_uri", redirectUri);
  }
  return NextResponse.redirect(dest, 303);
}
