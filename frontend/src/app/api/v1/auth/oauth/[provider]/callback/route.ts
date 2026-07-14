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

const NONCE_COOKIE = "ddaoauth";
const NEXT_COOKIE = "ddaoauthnext";
const POPUP_COOKIE = "ddaoauthpopup";

/**
 * HTML response for popup-mode OAuth: notify the opener window (the wizard) and
 * close the popup, so the main page never navigates (no redirect to home).
 */
function popupClose(status: "connected" | "needs_login"): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>GitHub</title>
<body style="font:14px system-ui;padding:24px;color:#444">Connected. You can close this window.</body>
<script>
  try { window.opener && window.opener.postMessage({ source: "dda-oauth", status: ${JSON.stringify(status)} }, window.location.origin); } catch (e) {}
  window.close();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * Smart return after a successful attach. Returns an HTML page that decides
 * CLIENT-SIDE whether it's running in a popup (via window.opener) — the most
 * reliable signal, independent of cookies/state/query params:
 *   - popup  → notify the opener (wizard) + close. The main window never moves.
 *   - normal → redirect to `nextPath`.
 * This is why the GitHub connect can never bounce the main window to the home page.
 */
function smartReturn(nextPath: string): NextResponse {
  const safe = nextPath && nextPath.startsWith("/") ? nextPath : "/u/dashboard";
  const html = `<!doctype html><meta charset="utf-8"><title>GitHub</title>
<body style="font:14px system-ui;padding:24px;color:#444">Finishing GitHub connection…</body>
<script>
(function () {
  var next = ${JSON.stringify(safe)};
  var isPopup = false;
  try { isPopup = !!(window.opener && window.opener !== window); } catch (e) { isPopup = false; }
  if (isPopup) {
    try { window.opener.postMessage({ source: "dda-oauth", status: "connected" }, window.location.origin); } catch (e) {}
    try { window.close(); } catch (e) {}
    // If the popup somehow can't close (rare), fall back to a redirect.
    setTimeout(function () { try { window.location.replace(next); } catch (e) {} }, 400);
  } else {
    window.location.replace(next);
  }
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await ctx.params;
  const url = new URL(req.url);
  const provider = await getProviderAsync(providerId);
  if (!provider) {
    return failureResponse("provider_unavailable", "OAuth provider isn't configured.", url);
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
    return failureResponse("provider_error", "The provider rejected the sign-in.", url);
  }
  if (!code || !state) {
    return failureResponse("missing_params", "Missing code or state.", url);
  }

  const jar = await cookies();
  const nonce = jar.get(NONCE_COOKIE)?.value;
  if (!nonce) {
    return failureResponse("missing_nonce", "Sign-in state expired. Try again.", url);
  }
  const verified = verifyState(state, nonce);
  if (!verified.ok) {
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, reason: verified.code },
    });
    return failureResponse(verified.code, "Sign-in state could not be verified.", url);
  }
  if (verified.provider !== providerId) {
    return failureResponse("provider_mismatch", "Sign-in state is for a different provider.", url);
  }

  // Single-use: clear the nonce as soon as it's been spent.
  jar.delete(NONCE_COOKIE);

  const origin = req.headers.get("origin") ?? url.origin;
  const ex = await exchange(provider, code, origin);
  if (!ex.ok) {
    await audit({
      action: "auth.oauth.failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { provider: providerId, reason: ex.code, message: ex.message },
    });
    return failureResponse(ex.code, ex.message, url);
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
  const isPopup = verified.popup || jar.get(POPUP_COOKIE)?.value === "1";
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
    return smartReturn(nextPath ?? "/u/dashboard");
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
    return failureResponse(resolved.code, "The provider hasn't verified that email.", url);
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
  return NextResponse.redirect(new URL(dest, url.origin));
}

/**
 * Build a failure response. In mock mode returns JSON for tests; otherwise
 * 303-redirects back to /auth/login carrying the failure code so the form
 * can render a human-readable message. The base origin is taken from the
 * request URL so the redirect works in any deployment, not just localhost.
 */
function failureResponse(code: string, message: string, requestUrl: URL) {
  if (isMockMode()) {
    return NextResponse.json({ ok: false, code, message }, { status: 400 });
  }
  const dest = new URL("/auth/login", requestUrl.origin);
  dest.searchParams.set("oauth_error", code);
  return NextResponse.redirect(dest, 303);
}
