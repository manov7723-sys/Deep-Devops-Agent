/**
 * Fresh-token resolution for connected OAuth accounts.
 *
 * GitHub tokens never expire, so historically callers just decrypted
 * `accessTokenRef` and used it. GitLab tokens EXPIRE after ~2h and carry a
 * ROTATING refresh token (single-use). This helper is the single place that:
 *   - decrypts the stored access token, and
 *   - for GitLab, transparently refreshes it (and persists the rotated pair)
 *     when it's at/near expiry — so every GitLab feature keeps working past 2h
 *     instead of dying silently.
 *
 * Used by the repo-listing routes and by repo-token.ts. Callers should not
 * decrypt `accessTokenRef` themselves.
 */
import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { getProviderAsync, gitlabBaseUrl } from "./providers";

/** Minimal shape needed to resolve + refresh a token. */
export type AccountTokenRow = {
  id: string;
  provider: "github" | "google" | "gitlab";
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  tokenExpiresAt: Date | null;
  providerBaseUrl: string | null;
};

/** Columns to select when you intend to call getFreshAccessTokenForAccount. */
export const accountTokenSelect = {
  id: true,
  provider: true,
  accessTokenRef: true,
  refreshTokenRef: true,
  tokenExpiresAt: true,
  providerBaseUrl: true,
} as const;

export type FreshToken =
  | { ok: true; accessToken: string; refreshed: boolean }
  | {
      ok: false;
      code: "no_token" | "decrypt_failed" | "reconnect" | "not_configured";
      message: string;
    };

// Refresh slightly before the real expiry to avoid racing the clock on a
// request that takes a moment to reach GitLab.
const EXPIRY_SKEW_MS = 60_000;

export async function getFreshAccessTokenForAccount(acc: AccountTokenRow): Promise<FreshToken> {
  if (!acc.accessTokenRef) {
    return {
      ok: false,
      code: "no_token",
      message: "Connected account has no access token — reconnect it.",
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(acc.accessTokenRef);
  } catch {
    return {
      ok: false,
      code: "decrypt_failed",
      message: "Could not decrypt the access token — reconnect this account.",
    };
  }

  // Only GitLab tokens expire. GitHub never expires; Google isn't used for repos.
  const expiresSoon =
    acc.tokenExpiresAt != null && acc.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
  if (acc.provider !== "gitlab" || !expiresSoon) {
    return { ok: true, accessToken, refreshed: false };
  }

  return refreshGitlab(acc);
}

async function refreshGitlab(acc: AccountTokenRow): Promise<FreshToken> {
  if (!acc.refreshTokenRef) {
    return {
      ok: false,
      code: "reconnect",
      message: "GitLab session expired and no refresh token is stored — reconnect GitLab.",
    };
  }
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(acc.refreshTokenRef);
  } catch {
    return {
      ok: false,
      code: "reconnect",
      message: "GitLab refresh token is unreadable — reconnect GitLab.",
    };
  }

  const cfg = await getProviderAsync("gitlab");
  if (!cfg || !cfg.clientId || !cfg.clientSecret) {
    return {
      ok: false,
      code: "not_configured",
      message: "GitLab OAuth is not configured on the server.",
    };
  }

  const base = (acc.providerBaseUrl || gitlabBaseUrl()).replace(/\/+$/, "");
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
    cache: "no-store",
  });

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };

  if (!res.ok || !body.access_token) {
    // Rotated refresh tokens are single-use. A concurrent request may have
    // already refreshed and rotated ours (invalid_grant). Re-read the row — if
    // it now holds a still-valid token, use that instead of failing.
    if (body.error === "invalid_grant") {
      const fresh = await prisma.oAuthAccount.findUnique({
        where: { id: acc.id },
        select: { accessTokenRef: true, tokenExpiresAt: true },
      });
      if (
        fresh?.accessTokenRef &&
        fresh.tokenExpiresAt &&
        fresh.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()
      ) {
        try {
          return { ok: true, accessToken: decryptSecret(fresh.accessTokenRef), refreshed: true };
        } catch {
          /* fall through to reconnect */
        }
      }
    }
    return {
      ok: false,
      code: "reconnect",
      message: "GitLab session expired — reconnect GitLab to continue.",
    };
  }

  const newAccess = body.access_token;
  const newRefresh = body.refresh_token || refreshToken;
  const expiresAt = body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000) : null;

  await prisma.oAuthAccount
    .update({
      where: { id: acc.id },
      data: {
        accessTokenRef: encryptSecret(newAccess),
        refreshTokenRef: encryptSecret(newRefresh),
        tokenExpiresAt: expiresAt,
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      },
    })
    .catch(() => {
      /* non-fatal: the token still works this request even if persistence fails */
    });

  return { ok: true, accessToken: newAccess, refreshed: true };
}
