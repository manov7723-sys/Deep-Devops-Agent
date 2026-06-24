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
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; error: string };

/** Get an ARM access token via the client-credentials grant. */
export async function getAzureSpToken(c: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<AzureTokenResult> {
  const tenant = c.tenantId.trim();
  if (!tenant || !c.clientId.trim() || !c.clientSecret) {
    return { ok: false, error: "tenantId, clientId and clientSecret are required." };
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: c.clientId.trim(),
    client_secret: c.clientSecret,
    scope: ARM_SCOPE,
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
    return { ok: false, error: `Network error reaching Microsoft sign-in: ${err instanceof Error ? err.message : "unknown"}` };
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // Surface the human-readable Microsoft error (e.g. AADSTS7000215 invalid secret).
    const msg = (json.error_description || json.error || `token request failed (${res.status})`).split("\n")[0];
    return { ok: false, error: msg };
  }
  return { ok: true, accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

export type AzureConnectResult =
  | { ok: true; subscriptionId: string; subscriptions: Array<{ id: string; displayName: string; state: string }> }
  | { ok: false; error: string };

/**
 * Validate a Service Principal end-to-end: authenticate, then list ARM
 * subscriptions to prove the credentials actually have access. Resolves the
 * subscription to use (the supplied one if visible, else the first enabled).
 * Mirrors azure_connector.connect().
 */
export async function connectAzureServicePrincipal(input: AzureSpInput): Promise<AzureConnectResult> {
  const tok = await getAzureSpToken(input);
  if (!tok.ok) return { ok: false, error: tok.error };

  let res: Response;
  try {
    res = await fetch(`${ARM}/subscriptions?api-version=2020-01-01`, {
      headers: { Authorization: `Bearer ${tok.accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Azure rejected the request (${res.status}). ${body.slice(0, 160)}` };
  }
  const data = (await res.json().catch(() => ({}))) as {
    value?: Array<{ subscriptionId: string; displayName: string; state: string }>;
  };
  const subs = (data.value ?? []).map((s) => ({ id: s.subscriptionId, displayName: s.displayName, state: s.state }));
  if (subs.length === 0) {
    return {
      ok: false,
      error: "Authenticated, but this service principal has no subscriptions assigned. Grant it a role (e.g. Contributor) on the subscription.",
    };
  }
  const wanted = input.subscriptionId?.trim();
  const chosen =
    (wanted && subs.find((s) => s.id === wanted)) ||
    subs.find((s) => s.state === "Enabled") ||
    subs[0];
  if (wanted && !subs.find((s) => s.id === wanted)) {
    return { ok: false, error: `Subscription ${wanted} isn't visible to this service principal. Visible: ${subs.map((s) => s.id).join(", ")}` };
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

/** Load + decrypt an Azure provider's Service-Principal credentials. */
export async function getDecryptedAzureCreds(cloudProviderId: string): Promise<DecryptedAzureCreds> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountRef: true, accountId: true, roleArn: true, externalId: true },
  });
  if (!cp) return { ok: false, error: "Cloud provider not found." };
  if (cp.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  if (!cp.accountId || !cp.roleArn || !cp.externalId) {
    return { ok: false, error: "Azure provider is missing tenant/client/secret." };
  }
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(cp.externalId);
  } catch {
    return { ok: false, error: "Could not decrypt the Azure client secret. Reconnect the provider." };
  }
  return { ok: true, tenantId: cp.accountId, clientId: cp.roleArn, clientSecret, subscriptionId: cp.accountRef };
}

/**
 * Get a usable ARM access token for a stored Azure provider, handling BOTH
 * connection methods. Convention on the row: `roleArn` holds the SP client id
 * (Service Principal) and is NULL for OAuth providers, where `externalId` holds
 * the encrypted refresh token instead of a client secret.
 */
export async function getAzureAccessToken(cloudProviderId: string): Promise<AzureTokenResult> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountId: true, roleArn: true, externalId: true },
  });
  if (!cp || cp.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  if (!cp.externalId) return { ok: false, error: "Azure provider has no stored credentials." };

  let secret: string;
  try {
    secret = decryptSecret(cp.externalId);
  } catch {
    return { ok: false, error: "Could not decrypt the stored Azure credential. Reconnect the provider." };
  }

  // Service Principal — client id present.
  if (cp.roleArn) {
    return getAzureSpToken({ tenantId: cp.accountId ?? "", clientId: cp.roleArn, clientSecret: secret });
  }

  // OAuth — `secret` is a refresh token. Mint an ARM token and rotate the
  // refresh token if Microsoft issued a new one.
  const r = await refreshAzureToken(secret);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.tokens.refreshToken && r.tokens.refreshToken !== secret) {
    await prisma.cloudProvider
      .update({ where: { id: cloudProviderId }, data: { externalId: encryptSecret(r.tokens.refreshToken) } })
      .catch(() => {});
  }
  return { ok: true, accessToken: r.tokens.accessToken, expiresIn: r.tokens.expiresIn };
}
