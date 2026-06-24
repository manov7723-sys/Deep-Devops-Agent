/**
 * HashiCorp Vault client (KV v2) for cloud credentials.
 *
 * The Vault CONNECTION (URL + token) is resolved per-user from the DB
 * (`VaultConfig`, see vault-config.ts), falling back to the VAULT_ADDR /
 * VAULT_TOKEN env vars. AWS access key + secret are stored in Vault (never in
 * Postgres) and the runner/agent read them back at execution time. Only a
 * non-secret *path* is kept in the database (`CloudProvider.credVaultPath`).
 *
 * KV v2 REST shape:
 *   write: POST  {addr}/v1/{mount}/data/{path}   body { data: {...} }
 *   read:  GET   {addr}/v1/{mount}/data/{path}  -> { data: { data: {...} } }
 *   del:   DELETE{addr}/v1/{mount}/metadata/{path}   (removes all versions)
 */
import {
  resolveVaultConn,
  resolveVaultConnForProvider,
  type VaultConn,
} from "./vault-config";

export type AwsKeys = {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
};

const DEFAULT_PREFIX = () => process.env.VAULT_PATH_PREFIX?.trim() || "dda/cloud";

/**
 * Sync env-only check. Still used where we only care whether the platform-level
 * env Vault is set. For the per-user picture use `getVaultConfigView`.
 */
export function vaultConfigured(): boolean {
  return Boolean(process.env.VAULT_ADDR?.trim() && process.env.VAULT_TOKEN?.trim());
}

/** Deterministic, per-provider Vault path. Never exposes secrets in the DB. */
export function providerVaultPath(providerId: string, prefix?: string): string {
  return `${(prefix ?? DEFAULT_PREFIX()).replace(/\/+$/, "")}/${providerId}`;
}

async function vaultFetch(
  conn: VaultConn,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${conn.addr}/v1/${path}`, {
    method,
    headers: {
      "X-Vault-Token": conn.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
}

export type VaultStatus = {
  configured: boolean;
  reachable: boolean;
  addr: string | null;
  mount: string;
  source: "db" | "env" | "none";
  error?: string;
};

/** Ping an explicit Vault connection's health endpoint. */
export async function pingVault(conn: VaultConn): Promise<{ reachable: boolean; error?: string }> {
  try {
    // Validate URL *and* token: lookup-self requires a valid token, so this
    // confirms both reachability and that the token works (unlike sys/health,
    // which is unauthenticated and would pass even with a bad token).
    const res = await vaultFetch(conn, "GET", "auth/token/lookup-self");
    if (res.status === 200) return { reachable: true };
    if (res.status === 403) return { reachable: false, error: "Token rejected (403) — check the Vault token." };
    if (res.status === 503) return { reachable: false, error: "Vault is sealed (503) — unseal it first." };
    if (res.status === 501) return { reachable: false, error: "Vault is not initialised (501)." };
    return { reachable: false, error: `Vault returned ${res.status}.` };
  } catch (e) {
    // Network-level failure — almost always Vault isn't running / not reachable.
    const msg = e instanceof Error ? (e.cause ? `${e.message} (${String(e.cause)})` : e.message) : String(e);
    return {
      reachable: false,
      error: `Could not reach Vault at ${conn.addr} — is it running and reachable from the server? [${msg}]`,
    };
  }
}

/** Connection status for a project's effective Vault (DB row or env). */
export async function vaultStatus(projectId: string | null): Promise<VaultStatus> {
  const conn = await resolveVaultConn(projectId);
  if (!conn) {
    return { configured: false, reachable: false, addr: null, mount: "secret", source: "none" };
  }
  // Callers that need `source` precisely use getVaultConfigView. Report "db"
  // when a projectId was supplied and resolved, else "env".
  const ping = await pingVault(conn);
  return {
    configured: true,
    reachable: ping.reachable,
    addr: conn.addr,
    mount: conn.mount,
    source: projectId ? "db" : "env",
    ...(ping.error ? { error: ping.error } : {}),
  };
}

/** Store an AWS access key + secret for a provider, into its owner's Vault. */
export async function saveAwsKeys(providerId: string, keys: AwsKeys): Promise<void> {
  const conn = await resolveVaultConnForProvider(providerId);
  if (!conn) throw new Error("Vault is not configured. Set up the Vault connection first.");
  const path = `${conn.prefix}/${providerId}`;
  const res = await vaultFetch(conn, "POST", `${conn.mount}/data/${path}`, {
    data: {
      aws_access_key_id: keys.accessKeyId,
      aws_secret_access_key: keys.secretAccessKey,
      ...(keys.region ? { region: keys.region } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Vault write failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

/** Read an AWS access key + secret back. Returns null if no secret exists. */
export async function getAwsKeys(providerId: string): Promise<AwsKeys | null> {
  const conn = await resolveVaultConnForProvider(providerId);
  if (!conn) return null;
  const path = `${conn.prefix}/${providerId}`;
  const res = await vaultFetch(conn, "GET", `${conn.mount}/data/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Vault read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { data?: Record<string, string> } };
  const data = json.data?.data;
  if (!data?.aws_access_key_id || !data?.aws_secret_access_key) return null;
  return {
    accessKeyId: data.aws_access_key_id,
    secretAccessKey: data.aws_secret_access_key,
    region: data.region,
  };
}

/** Remove all versions of a provider's stored secret. Idempotent. */
export async function deleteAwsKeys(providerId: string): Promise<void> {
  const conn = await resolveVaultConnForProvider(providerId);
  if (!conn) return;
  const path = `${conn.prefix}/${providerId}`;
  const res = await vaultFetch(conn, "DELETE", `${conn.mount}/metadata/${path}`);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Vault delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}
