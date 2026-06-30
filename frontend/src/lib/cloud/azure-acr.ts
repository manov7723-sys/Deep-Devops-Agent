/**
 * Azure Container Registry + keyless GitHub auth (OIDC federated credential).
 * ACR + role assignment go over ARM; the AD app + federated credential go over
 * Microsoft Graph. Both use the stored Service-Principal credential (Graph app
 * creation needs an SP with Application.ReadWrite + Directory perms — an OAuth
 * user/personal-account connection can't do this, so we fail with a clear hint).
 *
 * The keyless chain so GitHub Actions can push with NO secret:
 *   1. ACR (or use existing)
 *   2. AD app + service principal
 *   3. Federated credential on the app (issuer = GitHub OIDC, subject = repo)
 *   4. AcrPush role for the SP on the ACR
 * The workflow then uses azure/login with the app's client/tenant/subscription.
 */
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getAzureAccessToken, getAzureSpToken } from "./azure";

const ARM = "https://management.azure.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

type SpCreds = { tenantId: string; clientId: string; clientSecret: string; subscription: string };

/** Resolve the SP credentials needed for Graph (AD app creation). OAuth/user
 *  connections lack a client secret, so keyless setup isn't possible for them. */
async function resolveSp(cloudProviderId: string): Promise<Res<SpCreds>> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountId: true, accountRef: true, roleArn: true, externalId: true },
  });
  if (cp?.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  if (!cp.roleArn || !cp.externalId || !cp.accountId) {
    return {
      ok: false,
      error:
        "Keyless ACR setup needs a SERVICE-PRINCIPAL Azure connection (with Graph 'Application.ReadWrite.OwnedBy' + 'Directory' permission). " +
        "This project's Azure is connected as a user/OAuth account, which can't create the AD app. Reconnect Azure as a service principal.",
    };
  }
  const subscription = cp.accountRef?.trim();
  if (!subscription) return { ok: false, error: "Azure provider has no subscription id." };
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(cp.externalId);
  } catch {
    return { ok: false, error: "Could not decrypt the Azure credential. Reconnect the provider." };
  }
  return { ok: true, data: { tenantId: cp.accountId, clientId: cp.roleArn, clientSecret, subscription } };
}

async function http<T = Record<string, unknown>>(token: string, url: string, method = "GET", body?: unknown): Promise<Res<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: { message?: string } }) : ({} as T);
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } | string })?.error;
    return { ok: false, error: (typeof msg === "object" ? msg?.message : msg) || text.slice(0, 300) || `HTTP ${res.status}` };
  }
  return { ok: true, data };
}

export type AcrInfo = { name: string; resourceGroup: string; loginServer: string };

/** List ACRs in the subscription (ARM). */
export async function listAcr(cloudProviderId: string): Promise<Res<AcrInfo[]>> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sp = await resolveSp(cloudProviderId);
  const subscription = sp.ok ? sp.data.subscription : "";
  if (!subscription) return { ok: false, error: "No Azure subscription." };
  const r = await http<{ value?: Array<{ name?: string; id?: string; properties?: { loginServer?: string } }> }>(
    tok.accessToken,
    `${ARM}/subscriptions/${subscription}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-07-01`,
  );
  if (!r.ok) return r;
  const acrs = (r.data.value ?? []).map((a) => ({
    name: a.name ?? "",
    resourceGroup: (a.id ?? "").match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
    loginServer: a.properties?.loginServer ?? `${a.name}.azurecr.io`,
  }));
  return { ok: true, data: acrs };
}

/** Create an ACR (Basic SKU) in a resource group (ARM). Idempotent. */
export async function createAcr(cloudProviderId: string, resourceGroup: string, name: string, location: string): Promise<Res<AcrInfo>> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sp = await resolveSp(cloudProviderId);
  const subscription = sp.ok ? sp.data.subscription : "";
  if (!subscription) return { ok: false, error: "No Azure subscription." };
  const r = await http<{ properties?: { loginServer?: string } }>(
    tok.accessToken,
    `${ARM}/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
    "PUT",
    { location, sku: { name: "Basic" }, properties: { adminUserEnabled: false } },
  );
  if (!r.ok) return r;
  return { ok: true, data: { name, resourceGroup, loginServer: r.data.properties?.loginServer ?? `${name}.azurecr.io` } };
}

export type AzureOidcResult = { clientId: string; tenantId: string; subscriptionId: string };

/**
 * Set up keyless GitHub→Azure auth for one repo + ACR: AD app, federated
 * credential, and AcrPush role assignment. Returns client/tenant/subscription
 * for the workflow. SP-only (Graph). Idempotent on the app + credential.
 */
export async function setupGithubFederatedCredential(
  cloudProviderId: string,
  repoFullName: string,
  acrName: string,
  resourceGroup: string,
  branch = "main",
): Promise<Res<AzureOidcResult>> {
  const sp = await resolveSp(cloudProviderId);
  if (!sp.ok) return sp;
  const { tenantId, clientId, clientSecret, subscription } = sp.data;

  const graphTok = await getAzureSpToken({ tenantId, clientId, clientSecret }, "https://graph.microsoft.com/.default");
  if (!graphTok.ok) return { ok: false, error: `Graph auth failed: ${graphTok.error}` };
  const armTok = await getAzureAccessToken(cloudProviderId);
  if (!armTok.ok) return { ok: false, error: armTok.error };

  const appName = `deepagent-gha-${repoFullName.split("/")[1] ?? "app"}`.slice(0, 90);

  // 1 — Find or create the AD application.
  let appId: string | undefined; // objectId
  let appClientId: string | undefined; // appId (client id)
  const find = await http<{ value?: Array<{ id?: string; appId?: string }> }>(
    graphTok.accessToken,
    `${GRAPH}/applications?$filter=displayName eq '${appName}'`,
  );
  if (find.ok && find.data.value && find.data.value[0]) {
    appId = find.data.value[0].id;
    appClientId = find.data.value[0].appId;
  } else {
    const create = await http<{ id?: string; appId?: string }>(graphTok.accessToken, `${GRAPH}/applications`, "POST", { displayName: appName });
    if (!create.ok) return { ok: false, error: `Couldn't create the AD app: ${create.error}` };
    appId = create.data.id;
    appClientId = create.data.appId;
  }
  if (!appId || !appClientId) return { ok: false, error: "AD app has no id." };

  // 2 — Ensure a service principal exists for the app.
  const spFind = await http<{ value?: Array<{ id?: string }> }>(
    graphTok.accessToken,
    `${GRAPH}/servicePrincipals?$filter=appId eq '${appClientId}'`,
  );
  let spObjectId = spFind.ok ? spFind.data.value?.[0]?.id : undefined;
  if (!spObjectId) {
    const spCreate = await http<{ id?: string }>(graphTok.accessToken, `${GRAPH}/servicePrincipals`, "POST", { appId: appClientId });
    if (!spCreate.ok) return { ok: false, error: `Couldn't create the service principal: ${spCreate.error}` };
    spObjectId = spCreate.data.id;
  }
  if (!spObjectId) return { ok: false, error: "Service principal has no id." };

  // 3 — Federated credential (issuer = GitHub OIDC, subject = this repo+branch). Idempotent by name.
  const fcName = `gha-${branch}`;
  const fcSubject = `repo:${repoFullName}:ref:refs/heads/${branch}`;
  const fcList = await http<{ value?: Array<{ name?: string; subject?: string }> }>(
    graphTok.accessToken,
    `${GRAPH}/applications/${appId}/federatedIdentityCredentials`,
  );
  const exists = fcList.ok && (fcList.data.value ?? []).some((f) => f.subject === fcSubject);
  if (!exists) {
    const fc = await http(graphTok.accessToken, `${GRAPH}/applications/${appId}/federatedIdentityCredentials`, "POST", {
      name: fcName,
      issuer: "https://token.actions.githubusercontent.com",
      subject: fcSubject,
      audiences: ["api://AzureADTokenExchange"],
    });
    if (!fc.ok && !/already exists|conflict/i.test(fc.error)) return { ok: false, error: `Couldn't add the federated credential: ${fc.error}` };
  }

  // 4 — Assign AcrPush on the ACR to the SP (ARM role assignment). 8311e382… = AcrPush.
  const acrId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${acrName}`;
  const ACR_PUSH = "8311e382-0749-4cb8-b61a-304f252e45ec";
  // Deterministic GUID for the assignment name (idempotent): derive from sp+acr.
  const assignmentName = await deterministicGuid(`${spObjectId}:${acrName}:acrpush`);
  const ra = await http(
    armTok.accessToken,
    `${ARM}${acrId}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}?api-version=2022-04-01`,
    "PUT",
    {
      properties: {
        roleDefinitionId: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${ACR_PUSH}`,
        principalId: spObjectId,
        principalType: "ServicePrincipal",
      },
    },
  );
  if (!ra.ok && !/already exists|RoleAssignmentExists/i.test(ra.error)) return { ok: false, error: `Role assignment failed: ${ra.error}` };

  return { ok: true, data: { clientId: appClientId, tenantId, subscriptionId: subscription } };
}

/** A stable v5-ish GUID from a string (for idempotent role-assignment names). */
async function deterministicGuid(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const b = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`;
}
