/**
 * OAuth provider client-credentials store. Backs the admin UI for rotating
 * GitHub / Google OAuth client id + secret without touching env vars.
 *
 * Read path (used by `getProvider()` at OAuth start/callback time):
 *   getOAuthCredentials("github") → { clientId, clientSecret, enabled }
 *   Returns null when no row exists; the call site then falls back to env
 *   (preserved as a bootstrap mechanism for new installs).
 *
 * Write path (admin):
 *   listOAuthConfigs()                 → masked rows for the UI grid
 *   upsertOAuthConfig({...})           → persists; secret is encrypted
 *   setOAuthEnabled(provider, bool)    → toggle without rewriting secret
 *   clearOAuthConfig(provider)         → drop the row (fall back to env)
 */
import type { OAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

/** Public-facing row for the admin UI — never contains the secret. */
export type OAuthConfigRow = {
  provider: OAuthProvider;
  clientId: string;
  hasSecret: boolean;
  /** Masked tail of the secret (last 4 chars). Empty when not set. */
  secretMask: string;
  enabled: boolean;
  updatedAt: string;
};

export async function listOAuthConfigs(): Promise<OAuthConfigRow[]> {
  let rows: Awaited<ReturnType<typeof prisma.oAuthProviderConfig.findMany>>;
  try {
    rows = await prisma.oAuthProviderConfig.findMany({
      orderBy: { provider: "asc" },
    });
  } catch {
    // Table doesn't exist yet — surface an empty list to the admin UI
    // instead of failing the whole settings page. The operator's next step
    // is `npx prisma db push`.
    return [];
  }
  return rows.map((r) => {
    let mask = "";
    if (r.clientSecretRef) {
      try {
        const plain = decryptSecret(r.clientSecretRef);
        mask = plain.length > 4 ? `••••${plain.slice(-4)}` : "••••";
      } catch {
        mask = "•••• (decrypt error)";
      }
    }
    return {
      provider: r.provider,
      clientId: r.clientId,
      hasSecret: !!r.clientSecretRef,
      secretMask: mask,
      enabled: r.enabled,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export type UpsertOAuthConfigArgs = {
  provider: OAuthProvider;
  clientId: string;
  /** When omitted, the existing secret is kept (lets the admin rotate clientId without re-typing the secret). */
  clientSecret?: string;
  enabled?: boolean;
};

export async function upsertOAuthConfig(args: UpsertOAuthConfigArgs): Promise<OAuthConfigRow> {
  const existing = await prisma.oAuthProviderConfig.findUnique({
    where: { provider: args.provider },
    select: { clientSecretRef: true, enabled: true },
  });
  if (!existing && !args.clientSecret) {
    throw new Error("client_secret_required");
  }
  const clientSecretRef = args.clientSecret
    ? encryptSecret(args.clientSecret)
    : existing!.clientSecretRef;
  const enabled = args.enabled ?? existing?.enabled ?? true;

  const row = await prisma.oAuthProviderConfig.upsert({
    where: { provider: args.provider },
    create: {
      provider: args.provider,
      clientId: args.clientId,
      clientSecretRef,
      enabled,
    },
    update: {
      clientId: args.clientId,
      clientSecretRef,
      enabled,
    },
  });
  return (await listOneRowAsRow(row)) ?? {
    provider: row.provider,
    clientId: row.clientId,
    hasSecret: true,
    secretMask: "",
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function setOAuthEnabled(provider: OAuthProvider, enabled: boolean): Promise<void> {
  await prisma.oAuthProviderConfig.update({
    where: { provider },
    data: { enabled },
  });
}

export async function clearOAuthConfig(provider: OAuthProvider): Promise<void> {
  await prisma.oAuthProviderConfig.deleteMany({ where: { provider } });
}

/**
 * Internal read used by `getProvider()` to inject DB-stored creds. Returns
 * null when:
 *   - no row exists for this provider, or
 *   - the row's secret won't decrypt, or
 *   - the OAuthProviderConfig table doesn't exist yet (fresh install where
 *     the operator hasn't run `prisma db push`).
 *
 * Crucially, missing table is NOT a 500 — we degrade so the env-var fallback
 * in getProviderAsync() keeps working.
 */
export async function getOAuthCredentials(
  provider: OAuthProvider,
): Promise<{ clientId: string; clientSecret: string; enabled: boolean } | null> {
  let row: Awaited<ReturnType<typeof prisma.oAuthProviderConfig.findUnique>>;
  try {
    row = await prisma.oAuthProviderConfig.findUnique({ where: { provider } });
  } catch {
    // Missing table / migration not applied / db unreachable — let the
    // caller fall back to env vars instead of 500-ing the whole OAuth flow.
    return null;
  }
  if (!row) return null;
  try {
    return {
      clientId: row.clientId,
      clientSecret: decryptSecret(row.clientSecretRef),
      enabled: row.enabled,
    };
  } catch {
    return null;
  }
}

async function listOneRowAsRow(row: {
  provider: OAuthProvider;
  clientId: string;
  clientSecretRef: string;
  enabled: boolean;
  updatedAt: Date;
}): Promise<OAuthConfigRow | null> {
  try {
    const plain = decryptSecret(row.clientSecretRef);
    const mask = plain.length > 4 ? `••••${plain.slice(-4)}` : "••••";
    return {
      provider: row.provider,
      clientId: row.clientId,
      hasSecret: true,
      secretMask: mask,
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    return null;
  }
}
