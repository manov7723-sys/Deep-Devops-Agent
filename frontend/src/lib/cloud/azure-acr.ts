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

/**
 * Read the stored subscription id for this provider. Works for BOTH connection
 * kinds — SP and OAuth — because the subscription lives on `accountRef` on the
 * CloudProvider row regardless of how the user authenticated. Use this for any
 * read-only ARM call (list ACRs, list resource groups, etc.) instead of the
 * heavier `resolveSp`, which only makes sense when we actually need SP creds
 * for Microsoft Graph (AD app creation, federated credentials).
 */
async function resolveSubscription(cloudProviderId: string): Promise<Res<string>> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { kind: true, accountRef: true },
  });
  if (cp?.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  const subscription = cp.accountRef?.trim();
  if (!subscription) {
    return {
      ok: false,
      error: "Azure provider has no subscription id saved. Reconnect Azure and pick the subscription.",
    };
  }
  return { ok: true, data: subscription };
}

/** Resolve the SP credentials needed for Graph (AD app creation).
 *
 * Two credential shapes are supported:
 *   1) HYBRID (OAuth connect + auto-provisioned SP) — new. Populated by the
 *      OAuth callback via autoProvisionSpFromOAuth. Columns:
 *      spClientId + spClientSecretEnc. This is the preferred path.
 *   2) LEGACY full-SP connect — roleArn (clientId) + externalId (encrypted
 *      client secret). Still supported for tenants that connected as SP.
 *
 * OAuth-only rows (spClientId null AND roleArn null) return the same "needs SP"
 * error as before — the ACR admin-secret fallback path picks up from there.
 */
async function resolveSp(cloudProviderId: string): Promise<Res<SpCreds>> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: {
      kind: true,
      accountId: true,
      accountRef: true,
      roleArn: true,
      externalId: true,
      spClientId: true,
      spClientSecretEnc: true,
    },
  });
  if (cp?.kind !== "azure") return { ok: false, error: "Not an Azure provider." };
  if (!cp.accountId) return { ok: false, error: "Azure provider has no tenant id." };
  const subscription = cp.accountRef?.trim();
  if (!subscription) return { ok: false, error: "Azure provider has no subscription id." };

  // Hybrid: OAuth + auto-provisioned SP. The refresh token stays in externalId
  // for OAuth; the SP secret lives in spClientSecretEnc, so this decrypt uses
  // the right column and doesn't collide with the OAuth path.
  if (cp.spClientId && cp.spClientSecretEnc) {
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(cp.spClientSecretEnc);
    } catch {
      return { ok: false, error: "Could not decrypt the auto-provisioned SP secret. Reconnect Azure to re-provision." };
    }
    return { ok: true, data: { tenantId: cp.accountId, clientId: cp.spClientId, clientSecret, subscription } };
  }

  // Legacy full-SP connect: clientId in roleArn, secret in externalId.
  if (cp.roleArn && cp.externalId) {
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(cp.externalId);
    } catch {
      return { ok: false, error: "Could not decrypt the Azure credential. Reconnect the provider." };
    }
    return { ok: true, data: { tenantId: cp.accountId, clientId: cp.roleArn, clientSecret, subscription } };
  }

  // MARKER: setupAzureDeployRegistry regexes on this exact phrase to decide the
  // secret-mode fallback. Don't rewrite the prefix. The rest is intentionally
  // internal — DO NOT recommend "reconnect as SP" (violates the [[azure-stays-oauth]]
  // rule); the fallback path is the intended UX for OAuth-connected projects.
  return {
    ok: false,
    error: "Keyless ACR setup needs a SERVICE-PRINCIPAL Azure connection — using ACR admin secret fallback (this is expected for OAuth-connected Azure).",
  };
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

/** List ACRs in the subscription (ARM). Works for both OAuth and SP Azure
 *  connections — needs only an ARM token + subscription id, not SP creds. */
export async function listAcr(cloudProviderId: string): Promise<Res<AcrInfo[]>> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await resolveSubscription(cloudProviderId);
  if (!sub.ok) return { ok: false, error: sub.error };
  const r = await http<{ value?: Array<{ name?: string; id?: string; properties?: { loginServer?: string } }> }>(
    tok.accessToken,
    `${ARM}/subscriptions/${sub.data}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-07-01`,
  );
  if (!r.ok) return r;
  const acrs = (r.data.value ?? []).map((a) => ({
    name: a.name ?? "",
    resourceGroup: (a.id ?? "").match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
    loginServer: a.properties?.loginServer ?? `${a.name}.azurecr.io`,
  }));
  return { ok: true, data: acrs };
}

/** Create an ACR (Basic SKU) in a resource group (ARM). Idempotent. Works for
 *  both OAuth and SP Azure connections — only ARM permissions matter here. */
export async function createAcr(cloudProviderId: string, resourceGroup: string, name: string, location: string): Promise<Res<AcrInfo>> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await resolveSubscription(cloudProviderId);
  if (!sub.ok) return { ok: false, error: sub.error };
  const r = await http<{ properties?: { loginServer?: string } }>(
    tok.accessToken,
    `${ARM}/subscriptions/${sub.data}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
    "PUT",
    { location, sku: { name: "Basic" }, properties: { adminUserEnabled: false } },
  );
  if (!r.ok) return r;
  return { ok: true, data: { name, resourceGroup, loginServer: r.data.properties?.loginServer ?? `${name}.azurecr.io` } };
}

/**
 * Enable ACR's built-in admin user and fetch its username + password via ARM.
 * The admin user is a separate credential on the registry that speaks the Docker
 * Registry v2 API — a `docker login` from any CI runner works with it. Uses ONLY
 * ARM, no Microsoft Graph, so this works on OAuth-signed Azure connections that
 * can't do keyless federated credentials (which need Graph app-creation perms).
 */
export async function enableAcrAdminAndGetCreds(
  cloudProviderId: string,
  resourceGroup: string,
  name: string,
): Promise<Res<{ loginServer: string; username: string; password: string }>> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const sub = await resolveSubscription(cloudProviderId);
  if (!sub.ok) return { ok: false, error: sub.error };

  const acrArm = `${ARM}/subscriptions/${sub.data}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${name}`;

  // 1 — Ensure adminUserEnabled=true. PATCH is idempotent; a no-op when already on.
  const patch = await http(
    tok.accessToken,
    `${acrArm}?api-version=2023-07-01`,
    "PATCH",
    { properties: { adminUserEnabled: true } },
  );
  if (!patch.ok) return { ok: false, error: `Could not enable ACR admin user: ${patch.error}` };

  // 2 — Read the credentials. `listCredentials` returns two rotatable passwords;
  // password[0] is the primary.
  const creds = await http<{ username?: string; passwords?: Array<{ name?: string; value?: string }> }>(
    tok.accessToken,
    `${acrArm}/listCredentials?api-version=2023-07-01`,
    "POST",
    {},
  );
  if (!creds.ok) return { ok: false, error: `Could not fetch ACR admin credentials: ${creds.error}` };
  const username = creds.data.username ?? name;
  const password = creds.data.passwords?.[0]?.value;
  if (!password) return { ok: false, error: "ACR did not return a password." };

  return { ok: true, data: { loginServer: `${name}.azurecr.io`, username, password } };
}

/** Namespace ACR admin secrets by registry so one repo can push to many. */
export function acrSecretPrefix(acrName: string): string {
  return `ACR_${acrName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The three GitHub Actions secret names the ACR secret-mode workflow reads. */
export function acrSecretNames(acrName: string): { loginServer: string; username: string; password: string } {
  const p = acrSecretPrefix(acrName);
  return { loginServer: `${p}_LOGIN_SERVER`, username: `${p}_USERNAME`, password: `${p}_PASSWORD` };
}

/**
 * OAuth-friendly ACR push setup. Fallback for the keyless federated-credential
 * path (which needs Graph app-creation perms an OAuth Azure sign-in doesn't
 * have): enable the ACR admin user, fetch its creds, and write them to GitHub
 * Actions repo secrets. The generated workflow uses `docker/login-action` with
 * those secrets instead of `azure/login`. Works end-to-end for OAuth users.
 *
 * Sequential secret writes (not Promise.all) so a partial failure surfaces the
 * exact secret name that couldn't be written — Promise.all races surface a
 * random one. Each write is now read-back-verified in setRepoActionsSecret, so
 * a "204 but not persisted" write can't silently poison the workflow.
 */
export async function setupAcrSecretPush(
  cloudProviderId: string,
  githubToken: string,
  repoFullName: string,
  resourceGroup: string,
  acrName: string,
): Promise<Res<{ registry: string; loginServer: string; secretPrefix: string }>> {
  const { setRepoActionsSecret } = await import("@/lib/github/secrets");
  const c = await enableAcrAdminAndGetCreds(cloudProviderId, resourceGroup, acrName);
  if (!c.ok) return c;
  if (!c.data.loginServer || !c.data.username || !c.data.password) {
    return { ok: false, error: `ACR "${acrName}" returned an empty admin credential; try again.` };
  }

  const names = acrSecretNames(acrName);
  const writes: Array<{ name: string; value: string }> = [
    { name: names.loginServer, value: c.data.loginServer },
    { name: names.username, value: c.data.username },
    { name: names.password, value: c.data.password },
  ];
  for (const w of writes) {
    const r = await setRepoActionsSecret(githubToken, repoFullName, w.name, w.value);
    if (!r.ok) {
      return {
        ok: false,
        error: `Could not set GitHub Actions secret "${w.name}" for repo "${repoFullName}": ${r.error}. The connected GitHub token needs admin/secrets write on the repo.`,
      };
    }
  }
  return { ok: true, data: { registry: acrName, loginServer: c.data.loginServer, secretPrefix: acrSecretPrefix(acrName) } };
}

/**
 * Self-healing repair for the secret-mode ACR CI workflow. Called by the agent
 * when a `build-and-push-acr.yml` run fails with docker/login-action's
 * "Username and password required" — meaning one of the three ACR_*_LOGIN_SERVER
 * / _USERNAME / _PASSWORD secrets on the repo is missing or empty.
 *
 * Idempotent: re-enables the ACR admin user (no-op if already on), fetches the
 * current primary password, and rewrites all three secrets. Every write is
 * read-back-verified so this returns error only when the fix genuinely didn't
 * land. Returns the three secret names it (re)wrote so the caller can name
 * them back to the user for context.
 */
export async function repairAcrSecretPush(
  cloudProviderId: string,
  githubToken: string,
  repoFullName: string,
  resourceGroup: string,
  acrName: string,
): Promise<Res<{ secretNames: string[]; loginServer: string }>> {
  const setup = await setupAcrSecretPush(cloudProviderId, githubToken, repoFullName, resourceGroup, acrName);
  if (!setup.ok) return setup;
  const names = acrSecretNames(acrName);
  return {
    ok: true,
    data: {
      secretNames: [names.loginServer, names.username, names.password],
      loginServer: setup.data.loginServer.startsWith("http") ? setup.data.loginServer : setup.data.loginServer,
    },
  };
}

export type AzureOidcResult = { clientId: string; tenantId: string; subscriptionId: string; servicePrincipalObjectId: string };

export type AzurePushSetup =
  | { mode: "keyless"; clientId: string; tenantId: string; subscriptionId: string; servicePrincipalObjectId: string }
  | { mode: "secret"; registry: string; loginServer: string; secretPrefix: string };

/**
 * Parse an AKS kubeconfig's cluster name + resource group. The context name IS
 * the cluster name (no gke_/eks_-style prefix); the resource group is embedded
 * in the credential user, e.g. "clusterAdmin_rg-devops_agent-cluster" or
 * "clusterUser_<rg>_<cluster>" — the format `az aks get-credentials` writes.
 */
export function parseAksClusterRef(kubeconfig: string): { clusterName: string; resourceGroup: string | null } | null {
  const clusterName = kubeconfig.match(/current-context:\s*([A-Za-z0-9._-]+)/)?.[1];
  if (!clusterName) return null;
  const escaped = clusterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rg = kubeconfig.match(new RegExp(`user:\\s*cluster(?:Admin|User)_([A-Za-z0-9._-]+)_${escaped}\\b`))?.[1];
  return { clusterName, resourceGroup: rg ?? null };
}

/** Built-in role id for "Azure Kubernetes Service Cluster Admin Role". */
const AKS_CLUSTER_ADMIN_ROLE = "0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8";

/**
 * Grant a service principal admin access to fetch AKS credentials (the same
 * privilege level this app's own stored AKS kubeconfigs use — bypasses
 * in-cluster RBAC entirely, so it works regardless of whether the cluster uses
 * local accounts or Entra ID). Used so the CD workflow's federated app can
 * `az aks get-credentials --admin` with no stored secret. Idempotent.
 */
export async function grantAksClusterAdmin(
  cloudProviderId: string,
  servicePrincipalObjectId: string,
  resourceGroup: string,
  clusterName: string,
): Promise<Res<true>> {
  const armTok = await getAzureAccessToken(cloudProviderId);
  if (!armTok.ok) return { ok: false, error: armTok.error };
  const sp = await resolveSp(cloudProviderId);
  if (!sp.ok) return sp;
  const aksId = `/subscriptions/${sp.data.subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  const assignmentName = await deterministicGuid(`${servicePrincipalObjectId}:${clusterName}:aksadmin`);
  const ra = await http(
    armTok.accessToken,
    `${ARM}${aksId}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}?api-version=2022-04-01`,
    "PUT",
    {
      properties: {
        roleDefinitionId: `/subscriptions/${sp.data.subscription}/providers/Microsoft.Authorization/roleDefinitions/${AKS_CLUSTER_ADMIN_ROLE}`,
        principalId: servicePrincipalObjectId,
        principalType: "ServicePrincipal",
      },
    },
  );
  if (!ra.ok && !/already exists|RoleAssignmentExists/i.test(ra.error)) return { ok: false, error: `AKS admin role assignment failed: ${ra.error}` };
  return { ok: true, data: true };
}

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

  return { ok: true, data: { clientId: appClientId, tenantId, subscriptionId: subscription, servicePrincipalObjectId: spObjectId } };
}

export type AzureDeployRegistry =
  | {
      mode: "keyless";
      registry: string;
      loginServer: string;
      resourceGroup: string;
      clientId: string;
      tenantId: string;
      subscriptionId: string;
      servicePrincipalObjectId: string;
    }
  | {
      mode: "secret";
      registry: string;
      loginServer: string;
      resourceGroup: string;
      /** Prefix for the ACR_* GitHub Actions secrets — <PREFIX>_LOGIN_SERVER etc. */
      secretPrefix: string;
    };

/**
 * Full Azure setup for the one-shot deploy flow, for ONE service. Ensures the
 * ACR exists, then EITHER:
 *   - "keyless" — sets up a federated OIDC credential (needs an SP Azure conn
 *     with Graph perms) and grants the CI app AKS admin access. CI + CD are
 *     both keyless via azure/login.
 *   - "secret" — fallback for OAuth Azure sign-ins that can't create AD apps.
 *     Enables the ACR admin user and stores its credentials as repo secrets;
 *     the CI workflow docker-logs-in with those. AKS CD keyless is NOT set up
 *     in this mode (the caller falls back to server-side deploy or the
 *     KUBECONFIG_B64 CD variant).
 * Idempotent. Returns everything the caller needs for both the CI push
 * workflow and, in keyless mode, the CD deploy workflow.
 */
export async function setupAzureDeployRegistry(
  cloudProviderId: string,
  repoFullName: string,
  resourceGroup: string,
  acrName: string,
  location: string,
  branch: string,
  aks?: { clusterName: string; resourceGroup: string },
): Promise<Res<AzureDeployRegistry>> {
  const acr = await createAcr(cloudProviderId, resourceGroup, acrName, location);
  if (!acr.ok) return { ok: false, error: `Creating the ACR failed. ${acr.error}` };

  const oidc = await setupGithubFederatedCredential(cloudProviderId, repoFullName, acrName, resourceGroup, branch);
  if (oidc.ok) {
    if (aks) {
      const grant = await grantAksClusterAdmin(cloudProviderId, oidc.data.servicePrincipalObjectId, aks.resourceGroup, aks.clusterName);
      if (!grant.ok) return { ok: false, error: `Granting AKS deploy access failed. ${grant.error}` };
    }
    return {
      ok: true,
      data: {
        mode: "keyless",
        registry: acrName,
        loginServer: acr.data.loginServer,
        resourceGroup,
        clientId: oidc.data.clientId,
        tenantId: oidc.data.tenantId,
        subscriptionId: oidc.data.subscriptionId,
        servicePrincipalObjectId: oidc.data.servicePrincipalObjectId,
      },
    };
  }
  // Non-OAuth failure: surface it — don't silently mask a real Graph/ARM issue.
  if (!/Keyless ACR setup needs a SERVICE-PRINCIPAL Azure connection/i.test(oidc.error)) {
    return oidc;
  }

  // OAuth Azure connection — fall back to secret-based push.
  const { resolveTokenForRepo } = await import("@/lib/oauth/repo-token");
  const { prisma } = await import("@/lib/db/prisma");
  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName, deletedAt: null },
    select: { id: true },
  });
  if (!repo) return { ok: false, error: `Repo "${repoFullName}" is not registered.` };
  const gh = await resolveTokenForRepo(repo.id);
  if (!gh.ok) return { ok: false, error: `Could not resolve a GitHub token to store the ACR credentials: ${gh.message}` };

  const secret = await setupAcrSecretPush(cloudProviderId, gh.accessToken, repoFullName, resourceGroup, acrName);
  if (!secret.ok) return secret;

  return {
    ok: true,
    data: {
      mode: "secret",
      registry: acrName,
      loginServer: acr.data.loginServer,
      resourceGroup,
      secretPrefix: secret.data.secretPrefix,
    },
  };
}

/**
 * Discover every ACR that a repo's `.github/workflows/*.yml` push through
 * docker/login-action. Reads the YAML on the default branch, parses out the
 * `registry: X.azurecr.io` and the `${{ secrets.<PREFIX>_... }}` prefix so we
 * can match the on-repo workflow's own naming and not guess. The caller uses
 * this to auto-repair the secrets without the user having to name the ACR.
 */
export async function discoverAcrPushWorkflows(
  githubToken: string,
  repoFullName: string,
): Promise<Res<Array<{ workflowPath: string; registry: string; loginServer: string; secretPrefix: string }>>> {
  const listUrl = `https://api.github.com/repos/${repoFullName}/contents/.github/workflows`;
  let list: Response;
  try {
    list = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Network error listing workflows: ${e instanceof Error ? e.message : "error"}` };
  }
  if (list.status === 404) return { ok: true, data: [] };
  if (!list.ok) return { ok: false, error: `Couldn't list workflows (HTTP ${list.status}).` };
  const entries = (await list.json().catch(() => [])) as Array<{ name?: string; path?: string; type?: string }>;
  if (!Array.isArray(entries)) return { ok: true, data: [] };

  const results: Array<{ workflowPath: string; registry: string; loginServer: string; secretPrefix: string }> = [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name || !e.path) continue;
    if (!/\.ya?ml$/i.test(e.name)) continue;
    let file: Response;
    try {
      file = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${e.path}`, {
        headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        cache: "no-store",
      });
    } catch {
      continue;
    }
    if (!file.ok) continue;
    const j = (await file.json().catch(() => ({}))) as { content?: string; encoding?: string };
    if (!j.content) continue;
    let text: string;
    try {
      text = Buffer.from(j.content, (j.encoding as BufferEncoding) || "base64").toString("utf8");
    } catch {
      continue;
    }
    // ACR secret-mode signature: docker/login-action pointing at *.azurecr.io.
    if (!/docker\/login-action/i.test(text)) continue;
    const acrHost = text.match(/([a-z0-9-]+)\.azurecr\.io/i);
    if (!acrHost) continue;
    const prefixMatch = text.match(/secrets\.(ACR_[A-Z0-9_]+)_(?:LOGIN_SERVER|USERNAME|PASSWORD)/);
    if (!prefixMatch) continue;
    results.push({
      workflowPath: e.path,
      registry: acrHost[1],
      loginServer: `${acrHost[1]}.azurecr.io`,
      secretPrefix: prefixMatch[1],
    });
  }
  return { ok: true, data: results };
}

/**
 * Look up the resource group of an ACR the caller only knows by name. The
 * repair path uses this because the workflow YAML records the ACR name but not
 * the RG — the tool would otherwise need the user to remember which RG they
 * put it in. Returns null (ok: true) if the ACR doesn't exist in the sub.
 */
export async function findAcrResourceGroup(
  cloudProviderId: string,
  acrName: string,
): Promise<Res<string | null>> {
  const list = await listAcr(cloudProviderId);
  if (!list.ok) return list;
  const hit = list.data.find((a) => a.name.toLowerCase() === acrName.toLowerCase());
  return { ok: true, data: hit?.resourceGroup ?? null };
}

/**
 * Re-run the latest failed run of a workflow file. Called after the repair
 * function rewrites the secrets, so the fix takes effect without the user
 * having to push an empty commit or click "Re-run" in the GitHub UI.
 */
export async function rerunLatestFailedWorkflow(
  githubToken: string,
  repoFullName: string,
  workflowFileName: string,
): Promise<Res<{ rerunRunId: number | null; note: string }>> {
  const wfPath = `.github/workflows/${workflowFileName}`;
  const listUrl = `https://api.github.com/repos/${repoFullName}/actions/workflows/${encodeURIComponent(workflowFileName)}/runs?per_page=1`;
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  let res: Response;
  try {
    res = await fetch(listUrl, { headers, cache: "no-store" });
  } catch (e) {
    return { ok: false, error: `Network error listing runs: ${e instanceof Error ? e.message : "error"}` };
  }
  if (!res.ok) return { ok: false, error: `Couldn't list runs for ${wfPath} (HTTP ${res.status}).` };
  const data = (await res.json().catch(() => ({}))) as { workflow_runs?: Array<{ id?: number; conclusion?: string | null }> };
  const run = data.workflow_runs?.[0];
  if (!run?.id) return { ok: true, data: { rerunRunId: null, note: `No prior runs of ${wfPath} to re-run.` } };
  if (run.conclusion !== "failure") {
    return { ok: true, data: { rerunRunId: null, note: `Latest run of ${wfPath} is "${run.conclusion ?? "in-progress"}", not "failure" — nothing to re-run.` } };
  }
  let rerun: Response;
  try {
    rerun = await fetch(`https://api.github.com/repos/${repoFullName}/actions/runs/${run.id}/rerun-failed-jobs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (e) {
    return { ok: false, error: `Network error triggering rerun: ${e instanceof Error ? e.message : "error"}` };
  }
  if (rerun.status !== 201 && rerun.status !== 204) {
    const t = await rerun.text().catch(() => "");
    return { ok: false, error: `Couldn't trigger re-run of ${wfPath} (HTTP ${rerun.status}). ${t.slice(0, 160)}` };
  }
  return { ok: true, data: { rerunRunId: run.id, note: `Re-ran failed jobs on run ${run.id} of ${wfPath}.` } };
}

/** A stable v5-ish GUID from a string (for idempotent role-assignment names). */
async function deterministicGuid(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const b = Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`;
}
