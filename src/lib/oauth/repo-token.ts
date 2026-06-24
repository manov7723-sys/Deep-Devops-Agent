/**
 * Single source of truth for "which GitHub access token authenticates work on
 * this repo." Used by every code path that hits api.github.com or shells out
 * to git on behalf of a specific Repo row (pipelines, clones, status checks,
 * webhook PR comments…).
 *
 * Resolution order:
 *   1. The Repo's bound OAuthAccount (Repo.oauthAccountId). This is the
 *      strong identity: even when one DeepAgent user has multiple connected
 *      GitHub accounts, each Repo remembers which one discovered it.
 *   2. Fallback for legacy rows where oauthAccountId is null: the owner's
 *      most-recently-connected GitHub account. Backfilled on next sync.
 *
 * Callers should NEVER decrypt OAuthAccount.accessTokenRef directly — they'd
 * silently grab the wrong token in a multi-account world. Always go through
 * here.
 */
import type { OAuthAccount } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";

export type RepoTokenResolution =
  | {
      ok: true;
      accessToken: string;
      scope: string | null;
      account: {
        id: string;
        login: string | null;
        providerAccountId: string;
        userId: string;
      };
      /** True iff we used the legacy `repo.ownerId` fallback (oauthAccountId was null). */
      fromFallback: boolean;
    }
  | {
      ok: false;
      code:
        | "repo_not_found"
        | "no_account"
        | "no_token"
        | "decrypt_failed";
      message: string;
    };

export async function resolveTokenForRepo(repoId: string): Promise<RepoTokenResolution> {
  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
    select: {
      id: true,
      ownerId: true,
      oauthAccountId: true,
      oauthAccount: tokenSelect,
    },
  });
  if (!repo) {
    return { ok: false, code: "repo_not_found", message: "Repo not found." };
  }

  if (repo.oauthAccount) {
    return materialize(repo.oauthAccount, false);
  }

  // Legacy path: pick the owner's most-recently-connected GitHub account.
  const fallback = await prisma.oAuthAccount.findFirst({
    where: { userId: repo.ownerId, provider: "github" },
    orderBy: { createdAt: "desc" },
    select: tokenSelectFields,
  });
  if (!fallback) {
    return {
      ok: false,
      code: "no_account",
      message: "No connected GitHub account available for this repo's owner.",
    };
  }
  return materialize(fallback, true);
}

/**
 * Companion lookup when caller already has the Repo loaded (e.g. inside a
 * Pipeline query). Avoids a second roundtrip.
 */
export async function resolveTokenForOAuthAccountId(
  oauthAccountId: string | null,
  ownerIdFallback: string,
): Promise<RepoTokenResolution> {
  if (oauthAccountId) {
    const row = await prisma.oAuthAccount.findUnique({
      where: { id: oauthAccountId },
      select: tokenSelectFields,
    });
    if (!row) {
      return { ok: false, code: "no_account", message: "OAuth account row missing." };
    }
    return materialize(row, false);
  }
  const fallback = await prisma.oAuthAccount.findFirst({
    where: { userId: ownerIdFallback, provider: "github" },
    orderBy: { createdAt: "desc" },
    select: tokenSelectFields,
  });
  if (!fallback) {
    return {
      ok: false,
      code: "no_account",
      message: "No connected GitHub account available.",
    };
  }
  return materialize(fallback, true);
}

const tokenSelectFields = {
  id: true,
  userId: true,
  login: true,
  providerAccountId: true,
  scope: true,
  accessTokenRef: true,
} as const;

const tokenSelect = { select: tokenSelectFields } as const;

function materialize(
  row: Pick<
    OAuthAccount,
    "id" | "userId" | "login" | "providerAccountId" | "scope" | "accessTokenRef"
  >,
  fromFallback: boolean,
): RepoTokenResolution {
  if (!row.accessTokenRef) {
    return {
      ok: false,
      code: "no_token",
      message:
        "Connected GitHub account has no access token. Reconnect from /account/profile.",
    };
  }
  try {
    return {
      ok: true,
      accessToken: decryptSecret(row.accessTokenRef),
      scope: row.scope,
      account: {
        id: row.id,
        login: row.login,
        providerAccountId: row.providerAccountId,
        userId: row.userId,
      },
      fromFallback,
    };
  } catch {
    return {
      ok: false,
      code: "decrypt_failed",
      message: "Could not decrypt the access token. Reconnect this account.",
    };
  }
}
