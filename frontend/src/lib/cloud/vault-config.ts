/**
 * Per-PROJECT HashiCorp Vault CONNECTION config (URL + token). ISOLATION:
 * each project has its own Vault — set it in project A and it is NOT visible
 * in project B.
 *
 * The user supplies the Vault address + token (hvs.…) per project; we persist
 * it in `VaultConfig` (keyed by projectId) with the token ENCRYPTED at rest.
 * Storing AWS keys *in* Vault and the agent's runtime reads both resolve their
 * connection through here — from the provider's project. Falls back to the
 * VAULT_ADDR / VAULT_TOKEN env vars when no row exists.
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

export type VaultConn = { addr: string; token: string; mount: string; prefix: string };

export type VaultConfigView = {
  configured: boolean;
  source: "db" | "env" | "none";
  addr: string | null;
  mount: string;
  prefix: string;
  /** Whether a token is stored (the token itself is never returned). */
  hasToken: boolean;
};

const ENV_MOUNT = () => process.env.VAULT_KV_MOUNT?.trim() || "secret";
const ENV_PREFIX = () => process.env.VAULT_PATH_PREFIX?.trim() || "dda/cloud";
const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * Resolve the effective Vault connection for a PROJECT: its saved DB row first,
 * else the platform env vars. Returns null when neither is available.
 */
export async function resolveVaultConn(projectId: string | null): Promise<VaultConn | null> {
  if (projectId) {
    const row = await prisma.vaultConfig.findUnique({ where: { projectId } });
    if (row) {
      let token = "";
      try {
        token = decryptSecret(row.tokenEnc);
      } catch {
        token = "";
      }
      if (token) {
        return { addr: stripTrailingSlash(row.addr), token, mount: row.kvMount, prefix: row.pathPrefix };
      }
    }
  }
  const addr = process.env.VAULT_ADDR?.trim();
  const token = process.env.VAULT_TOKEN?.trim();
  if (addr && token) {
    return { addr: stripTrailingSlash(addr), token, mount: ENV_MOUNT(), prefix: ENV_PREFIX() };
  }
  return null;
}

/**
 * Resolve the connection for the PROJECT that owns a cloud provider (the
 * agent/runner path). A provider belongs to one project, so its keys live in
 * that project's Vault.
 */
export async function resolveVaultConnForProvider(providerId: string): Promise<VaultConn | null> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: providerId },
    select: { projectId: true },
  });
  return resolveVaultConn(cp?.projectId ?? null);
}

/** Non-secret view of a project's Vault config for the UI. Never returns the token. */
export async function getVaultConfigView(projectId: string): Promise<VaultConfigView> {
  const row = await prisma.vaultConfig.findUnique({ where: { projectId } });
  if (row) {
    return { configured: true, source: "db", addr: row.addr, mount: row.kvMount, prefix: row.pathPrefix, hasToken: true };
  }
  const addr = process.env.VAULT_ADDR?.trim();
  const token = process.env.VAULT_TOKEN?.trim();
  if (addr && token) {
    return { configured: true, source: "env", addr, mount: ENV_MOUNT(), prefix: ENV_PREFIX(), hasToken: true };
  }
  return { configured: false, source: "none", addr: null, mount: ENV_MOUNT(), prefix: ENV_PREFIX(), hasToken: false };
}

/** Upsert a project's Vault connection. Token is encrypted before storage. */
export async function saveVaultConfig(
  projectId: string,
  input: { addr: string; token: string; kvMount?: string; pathPrefix?: string },
): Promise<void> {
  const addr = stripTrailingSlash(input.addr.trim());
  const tokenEnc = encryptSecret(input.token.trim());
  await prisma.vaultConfig.upsert({
    where: { projectId },
    create: {
      projectId,
      addr,
      tokenEnc,
      ...(input.kvMount ? { kvMount: input.kvMount } : {}),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    },
    update: {
      addr,
      tokenEnc,
      ...(input.kvMount ? { kvMount: input.kvMount } : {}),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    },
  });
}

/** Remove a project's saved Vault connection. Idempotent. */
export async function deleteVaultConfig(projectId: string): Promise<void> {
  await prisma.vaultConfig.deleteMany({ where: { projectId } });
}
