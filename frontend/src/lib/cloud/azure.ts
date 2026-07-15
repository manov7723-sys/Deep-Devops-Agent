/**
 * Azure connection via a Service Principal (client credentials) — the TS port
 * of the Python backend's `azure_connector.connect()`. Given tenant + client id
 * + client secret, we authenticate against Microsoft Entra (Azure AD) and
 * validate by listing the account's subscriptions through Azure Resource
 * Manager (ARM). No SDK — plain OAuth2 client-credentials + ARM REST, the same
 * shape as the rest of this app's cloud connectors.
 *
 * The client secret is encrypted at rest (AES-256-GCM via encryptSecret) and
 * stored in `CloudProvider.externalId`; this module decrypts it to mint ARM
 * access tokens on demand.
 *
 * Field mapping on the CloudProvider row (kind="azure"):
 *   accountRef = Subscription ID   accountId = Tenant ID
 *   roleArn    = App (Client) ID   externalId = encrypted Client secret
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";
import { refreshAzureToken } from "./azure-oauth";

const ARM = "https://management.azure.com";
const ARM_SCOPE = `${ARM}/.default`;
const LOGIN = "https://login.microsoftonline.com";

export type AzureSpInput = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId?: string;
};

export type AzureTokenResult =
  { ok: true; accessToken: string; expiresIn: number } | { ok: false; error: string };

/** Get a client-credentials access token. Defaults to ARM; pass a different
 *  `scope` (e.g. the AKS AAD server app) to authenticate to other resources. */
export async function getAzureSpToken(
  c: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  },
  scope: string = ARM_SCOPE,
): Promise<AzureTokenResult> {
  const tenant = c.tenantId.trim();
  if (!tenant || !c.clientId.trim() || !c.clientSecret) {
    return { ok: false, error: "tenantId, clientId and clientSecret are required." };
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: c.clientId.trim(),
    client_secret: c.clientSecret,
    scope,
  });
  let res: Response;
  try {
    res = await fetch(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error reaching Microsoft sign-in: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // Surface the human-readable Microsoft error (e.g. AADSTS7000215 invalid secret).
    const msg = (
      json.error_description ||
      json.error ||
      `token request failed (${res.status})`
    ).split("\n")[0];
    return { ok: false, error: msg };
  }
  return { ok: true, accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

export type AzureConnectResult =
  | {
      ok: true;
      subscriptionId: string;
      subscriptions: Array<{ id: string; displayName: string; state: string }>;
    }
  | { ok: false; error: string };

/**
 * Validate a Service Principal end-to-end: authenticate, then list ARM
 * subscriptions to prove the credentials actually have access. Resolves the
 * subscription to use (the supplied one if visible, else the first enabled).
 * Mirrors azure_connector.connect().
 */
export async function connectAzureServicePrincipal(
  input: AzureSpInput,
): Promise<AzureConnectResult> {
  const tok = await getAzureSpToken(input);
  if (!tok.ok) return { ok: false, error: tok.error };

  let res: Response;
  try {
    res = await fetch(`${ARM}/subscriptions?api-version=2020-01-01`, {
      headers: { Authorization: `Bearer ${tok.accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Azure rejected the request (${res.status}). ${body.slice(0, 160)}`,
    };
  }
  const data = (await res.json().catch(() => ({}))) as {
    value?: Array<{ subscriptionId: string; displayName: string; state: string }>;
  };
  const subs = (data.value ?? []).map((s) => ({
    id: s.subscriptionId,
    displayName: s.displayName,
    state: s.state,
  }));
  if (subs.length === 0) {
    return {
      ok: false,
      error:
        "Authenticated, but this service principal has no subscriptions assigned. Grant it a role (e.g. Contributor) on the subscription.",
    };
  }
  const wanted = input.subscriptionId?.trim();
  const chosen =
    (wanted && subs.find((s) => s.id === wanted)) ||
    subs.find((s) => s.state === "Enabled") ||
    subs[0];
  if (wanted && !subs.find((s) => s.id === wanted)) {
    return {
      ok: false,
      error: `Subscription ${wanted} isn't visible to this service principal. Visible: ${subs.map((s) => s.id).join(", ")}`,
    };
  }
  return { ok: true, subscriptionId: chosen.id, subscriptions: subs };
}

/** Encrypt a client secret for storage in CloudProvider.externalId. */
export function encryptAzureSecret(clientSecret: string): string {
  return encryptSecret(clientSecret);
}

export type DecryptedAzureCreds =
  | { ok: true; tenantId: string; clientId: string; clientSecret: string; subscriptionId: string }
  | { ok: false; error: string };

/** Load + decrypt an Azure provider's Service-Principal credentials.
 *  Prefers the hybrid columns (spClientId + spClientSecretEnc, populated by the
 *  OAuth callback's auto-provisioning) and falls back to the legacy columns
 *  (roleArn + externalId) for full-SP connects. */
export async function getDecryptedAzureCreds(
  cloudProviderId: string,
): Promise<DecryptedAzureCreds> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: {
      kind: true,
      accountRef: true,
      accountId: true,
      roleArn: true,
      externalId: true,
      spClientId: true,
      spClientSecretEnc: true,
    },
  });
  if (!cp) return { ok: false, error: "Cloud provider not found." };
  if (cp.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  if (!cp.accountId) return { ok: false, error: "Azure provider has no tenant id." };

  if (cp.spClientId && cp.spClientSecretEnc) {
    try {
      const clientSecret = decryptSecret(cp.spClientSecretEnc);
      return {
        ok: true,
        tenantId: cp.accountId,
        clientId: cp.spClientId,
        clientSecret,
        subscriptionId: cp.accountRef,
      };
    } catch {
      return {
        ok: false,
        error: "Could not decrypt the auto-provisioned SP secret. Reconnect Azure to re-provision.",
      };
    }
  }
  if (cp.roleArn && cp.externalId) {
    try {
      const clientSecret = decryptSecret(cp.externalId);
      return {
        ok: true,
        tenantId: cp.accountId,
        clientId: cp.roleArn,
        clientSecret,
        subscriptionId: cp.accountRef,
      };
    } catch {
      return {
        ok: false,
        error: "Could not decrypt the Azure client secret. Reconnect the provider.",
      };
    }
  }
  return {
    ok: false,
    error:
      "Azure provider has no service-principal credentials (OAuth-only). Auto-provisioning may not have run yet.",
  };
}

// Well-known AKS Microsoft Entra **server** application — the audience a
// kubeconfig token must target to authenticate to an AAD-integrated cluster.
const AKS_AAD_SERVER_APP_ID = "6dae42f8-4368-4678-94ff-3960e28e3630";

/**
 * Mint a token the API server of an Entra-integrated AKS cluster will accept,
 * using the project's stored Service Principal. Lets the app build a
 * self-contained, token-based kubeconfig for AAD clusters — no kubelogin, no
 * `az`. Only works for SP-connected providers (OAuth providers store a refresh
 * token, not a client secret).
 */
export async function getAksAadToken(cloudProviderId: string): Promise<AzureTokenResult> {
  const creds = await getDecryptedAzureCreds(cloudProviderId);
  if (!creds.ok) return { ok: false, error: creds.error };
  return getAzureSpToken(creds, `${AKS_AAD_SERVER_APP_ID}/.default`);
}

/**
 * Get a usable ARM access token for a stored Azure provider. Three shapes:
 *   1. LEGACY SP    — roleArn (clientId) + externalId (encrypted secret)
 *   2. OAUTH only   — externalId (encrypted refresh token), no SP
 *   3. HYBRID       — externalId (OAuth refresh token) AND
 *                     spClientId + spClientSecretEnc (auto-provisioned SP).
 *                     Prefers OAuth for ARM (delegated tokens carry the user's
 *                     actual RBAC), transparently falls back to SP if the
 *                     refresh token has been revoked or expired — so an OAuth
 *                     token going stale never breaks the app for hybrid rows.
 */
export async function getAzureAccessToken(
  cloudProviderId: string,
  tenantOverride?: string,
): Promise<AzureTokenResult> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: {
      kind: true,
      accountId: true,
      roleArn: true,
      externalId: true,
      spClientId: true,
      spClientSecretEnc: true,
    },
  });
  if (!cp || cp.kind !== "azure") return { ok: false, error: "Not an Azure provider." };

  // Legacy full-SP row — roleArn + externalId. Client-credentials only.
  if (cp.roleArn && cp.externalId) {
    let secret: string;
    try {
      secret = decryptSecret(cp.externalId);
    } catch {
      return {
        ok: false,
        error: "Could not decrypt the stored Azure credential. Reconnect the provider.",
      };
    }
    return getAzureSpToken({
      tenantId: tenantOverride || cp.accountId || "",
      clientId: cp.roleArn,
      clientSecret: secret,
    });
  }

  // OAuth (with or without hybrid SP). Try refresh first — delegated tokens
  // carry the user's actual RBAC and are the preferred path when working.
  let oauthErr: string | null = null;
  if (cp.externalId) {
    let secret: string;
    try {
      secret = decryptSecret(cp.externalId);
      // Use the tenant STORED on this provider row (set by the OAuth callback
      // from the token's `tid` claim). Falling back to the env default (usually
      // /common/ or /organizations/) breaks personal Microsoft accounts whose
      // subscription lives in a specific tenant — ARM refuses those refresh
      // requests with AADSTS70011 "scope does not exist".
      const refreshTenant = tenantOverride || cp.accountId || undefined;
      const r = await refreshAzureToken(secret, refreshTenant);
      if (r.ok) {
        if (r.tokens.refreshToken && r.tokens.refreshToken !== secret) {
          await prisma.cloudProvider
            .update({
              where: { id: cloudProviderId },
              data: { externalId: encryptSecret(r.tokens.refreshToken) },
            })
            .catch(() => {});
        }
        return { ok: true, accessToken: r.tokens.accessToken, expiresIn: r.tokens.expiresIn };
      }
      oauthErr = r.error;
    } catch {
      oauthErr = "Could not decrypt the stored OAuth refresh token.";
    }
  }

  // Hybrid fallback — auto-provisioned SP for when OAuth refresh fails/expires.
  if (cp.spClientId && cp.spClientSecretEnc) {
    let secret: string;
    try {
      secret = decryptSecret(cp.spClientSecretEnc);
    } catch {
      return {
        ok: false,
        error: "Could not decrypt the auto-provisioned SP secret. Reconnect Azure to re-provision.",
      };
    }
    return getAzureSpToken({
      tenantId: tenantOverride || cp.accountId || "",
      clientId: cp.spClientId,
      clientSecret: secret,
    });
  }

  return { ok: false, error: oauthErr || "Azure provider has no stored credentials." };
}

/**
 * Fetch a storage account's access key via ARM (Microsoft.Storage listKeys),
 * using the provider's stored creds. Contributor on the subscription includes
 * `Microsoft.Storage/storageAccounts/listkeys/action`, so no extra data-plane
 * role is needed. The key lets Terraform's azurerm backend authenticate to the
 * state blob with shared-key auth — sidestepping the separate "Storage Blob
 * Data Contributor" RBAC that AAD-based blob access would otherwise require.
 */
export async function getAzureStorageAccountKey(
  cloudProviderId: string,
  resourceGroup: string,
  storageAccount: string,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { accountRef: true },
  });
  if (!cp?.accountRef) return { ok: false, error: "Provider has no subscription id." };

  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  const url =
    `https://management.azure.com/subscriptions/${cp.accountRef}` +
    `/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/` +
    `${storageAccount}/listKeys?api-version=2023-01-01`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.accessToken}`, "Content-Length": "0" },
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error listing storage keys: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `listKeys returned ${res.status} for ${storageAccount} in ${resourceGroup}.`,
    };
  }
  const j = (await res.json().catch(() => ({}))) as { keys?: Array<{ value?: string }> };
  const key = j.keys?.[0]?.value;
  if (!key) return { ok: false, error: "listKeys returned no keys." };
  return { ok: true, key };
}
