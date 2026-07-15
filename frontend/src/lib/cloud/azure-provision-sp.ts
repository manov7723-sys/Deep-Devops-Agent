/**
 * Hybrid Azure auth: right after OAuth sign-in, use the user's delegated Graph
 * + ARM tokens to auto-provision a Service Principal that the app owns and
 * stores. Keyless deployment (federated credentials, AKS admin grant, ACR
 * OIDC) then works for OAuth-connected projects without falling back to
 * ACR admin secrets. Best-effort — every failure downgrades cleanly to the
 * existing OAuth-only path, so the connect UX is never blocked.
 *
 * Prereqs (portal side, out of band):
 *   1. The OAuth app registration must have delegated Graph permission
 *      `Application.ReadWrite.OwnedBy` with tenant-admin consent granted.
 *   2. The signed-in user must be Owner (or User Access Administrator) on the
 *      subscription — role assignment writes need Microsoft.Authorization/
 *      roleAssignments/write, which Contributor doesn't have.
 * Both prereqs are checked at runtime; when either is missing, the helper
 * returns `{ ok: false }` with a human-readable reason and the caller drops
 * the SP path (auto-heal / ACR admin fallback remain in place).
 */
import { refreshAzureGraphToken, azureOAuthGraphEnabled } from "./azure-oauth";

const ARM = "https://management.azure.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

/** Built-in "Contributor" role id — enough for the app to create resource
 *  groups, ACRs, AKS clusters, and read/write ARM. Not Owner (no role
 *  assignments), not Reader (can't create). The right least-privilege for
 *  end-to-end deploys. */
const CONTRIBUTOR_ROLE = "b24988ac-6180-42a0-ab88-20f7382dd24c";
/** "Storage Blob Data Contributor" role id — read/write blobs via AAD. Needed
 *  because Terraform's azurerm state backend uses AAD auth on blobs by default,
 *  and Contributor covers management-plane storage ops but NOT blob data-plane.
 *  Without this the SP hits 403 InsufficientAccountPermissions on state lock. */
const STORAGE_BLOB_DATA_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";

async function graph<T = Record<string, unknown>>(
  token: string,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown,
): Promise<Res<T>> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching Microsoft Graph: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  const text = await res.text();
  const data = text
    ? (JSON.parse(text) as T & { error?: { message?: string; code?: string } })
    : ({} as T);
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    return { ok: false, error: err?.message || text.slice(0, 300) || `Graph HTTP ${res.status}` };
  }
  return { ok: true, data };
}

async function arm<T = Record<string, unknown>>(
  token: string,
  url: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<Res<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching Azure ARM: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: { message?: string } }) : ({} as T);
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } | string }).error;
    return {
      ok: false,
      error:
        (typeof msg === "object" ? msg?.message : msg) ||
        text.slice(0, 300) ||
        `ARM HTTP ${res.status}`,
    };
  }
  return { ok: true, data };
}

export type AutoProvisionedSp = {
  clientId: string;
  clientSecret: string;
  servicePrincipalObjectId: string;
  appDisplayName: string;
};

/**
 * Provision a Service Principal for the given (tenantId, subscriptionId) using
 * the signed-in user's OAuth refresh token. Idempotent: if the display name
 * already exists in the tenant, reuses it and rotates the password. Steps:
 *   1) Refresh Graph token from the OAuth refresh token
 *   2) Find or create the AD application (displayName: "deepagent-<sub>-<8hex>")
 *   3) Ensure a service principal exists for the app
 *   4) Add a password credential (rotated each call — old ones stay until
 *      GC or explicit revoke)
 *   5) Grant Contributor on the subscription (via the user's ARM token —
 *      the delegated user must be sub Owner / User Access Administrator)
 * Returns everything the app needs to persist on the CloudProvider row.
 */
export async function autoProvisionSpFromOAuth(args: {
  oauthRefreshToken: string;
  userArmAccessToken: string;
  tenantId: string;
  subscriptionId: string;
  displayNameHint?: string;
}): Promise<Res<AutoProvisionedSp>> {
  if (!azureOAuthGraphEnabled()) {
    return {
      ok: false,
      error: "SP auto-provisioning is disabled (AZURE_OAUTH_GRAPH_ENABLED not set).",
    };
  }

  // 1 — Graph token from the refresh token. This is where "admin consent not
  //     granted" fails loudly (AADSTS65001) — surface it verbatim.
  const graphTok = await refreshAzureGraphToken(args.oauthRefreshToken, args.tenantId);
  if (!graphTok.ok) {
    return { ok: false, error: `Couldn't acquire a Graph token: ${graphTok.error}` };
  }
  const gtok = graphTok.tokens.accessToken;

  const appName = (args.displayNameHint || `deepagent-${args.subscriptionId.slice(0, 8)}`).slice(
    0,
    90,
  );

  // 2 — Find or create the app registration by displayName.
  let appObjectId: string | undefined;
  let appClientId: string | undefined;
  const search = await graph<{ value?: Array<{ id?: string; appId?: string }> }>(
    gtok,
    `/applications?$filter=displayName eq '${appName.replace(/'/g, "''")}'&$select=id,appId`,
  );
  if (search.ok && search.data.value && search.data.value.length > 0) {
    appObjectId = search.data.value[0].id;
    appClientId = search.data.value[0].appId;
  } else {
    const create = await graph<{ id?: string; appId?: string }>(gtok, "/applications", "POST", {
      displayName: appName,
      signInAudience: "AzureADMyOrg",
    });
    if (!create.ok) return { ok: false, error: `Creating the AD app failed: ${create.error}` };
    appObjectId = create.data.id;
    appClientId = create.data.appId;
  }
  if (!appObjectId || !appClientId)
    return { ok: false, error: "AD app is missing id/appId after create." };

  // 3 — Ensure a service principal exists for the app.
  let spObjectId: string | undefined;
  const spSearch = await graph<{ value?: Array<{ id?: string }> }>(
    gtok,
    `/servicePrincipals?$filter=appId eq '${appClientId}'&$select=id`,
  );
  if (spSearch.ok && spSearch.data.value && spSearch.data.value[0]?.id) {
    spObjectId = spSearch.data.value[0].id;
  } else {
    const spCreate = await graph<{ id?: string }>(gtok, "/servicePrincipals", "POST", {
      appId: appClientId,
    });
    if (!spCreate.ok)
      return { ok: false, error: `Creating the service principal failed: ${spCreate.error}` };
    spObjectId = spCreate.data.id;
  }
  if (!spObjectId) return { ok: false, error: "Service principal is missing id after create." };

  // 4 — Rotate a fresh client secret. Two-year expiry — the app can rotate
  //     server-side later; long enough to avoid re-consent noise.
  const twoYears = new Date();
  twoYears.setUTCFullYear(twoYears.getUTCFullYear() + 2);
  const addPw = await graph<{ secretText?: string }>(
    gtok,
    `/applications/${appObjectId}/addPassword`,
    "POST",
    {
      passwordCredential: { displayName: "deepagent-auto", endDateTime: twoYears.toISOString() },
    },
  );
  if (!addPw.ok || !addPw.data.secretText) {
    return {
      ok: false,
      error: `Rotating the client secret failed: ${addPw.ok ? "no secretText" : addPw.error}`,
    };
  }
  const clientSecret = addPw.data.secretText;

  // 5 — Grant Contributor on the subscription. Requires the OAuth USER to be
  //     Owner / User Access Administrator on the sub. Idempotent — a stable
  //     GUID for the assignment name avoids duplicate-write errors on rerun.
  const assignmentName = await deterministicGuid(
    `${spObjectId}:${args.subscriptionId}:contributor`,
  );
  const roleUrl =
    `${ARM}/subscriptions/${args.subscriptionId}` +
    `/providers/Microsoft.Authorization/roleAssignments/${assignmentName}?api-version=2022-04-01`;
  const ra = await arm(args.userArmAccessToken, roleUrl, "PUT", {
    properties: {
      roleDefinitionId: `/subscriptions/${args.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE}`,
      principalId: spObjectId,
      principalType: "ServicePrincipal",
    },
  });
  if (!ra.ok && !/already exists|RoleAssignmentExists/i.test(ra.error)) {
    return {
      ok: false,
      error:
        `Granting Contributor on the subscription failed: ${ra.error}. ` +
        `The signed-in user must be Owner or User Access Administrator on the subscription.`,
    };
  }

  // 6 — Grant Storage Blob Data Contributor on the subscription too, so any
  //     state-storage account provisioned later (in this or any RG) inherits
  //     data-plane blob access. Without this, Terraform's azurerm backend hits
  //     403 InsufficientAccountPermissions on the state blob even though
  //     Contributor covers listKeys and management-plane storage ops.
  //     Non-fatal: if this write fails (rare), the deploy path can still
  //     retry via the storage-account-scoped grant.
  const blobAssignmentName = await deterministicGuid(
    `${spObjectId}:${args.subscriptionId}:blobdata`,
  );
  const blobRoleUrl =
    `${ARM}/subscriptions/${args.subscriptionId}` +
    `/providers/Microsoft.Authorization/roleAssignments/${blobAssignmentName}?api-version=2022-04-01`;
  const blobRa = await arm(args.userArmAccessToken, blobRoleUrl, "PUT", {
    properties: {
      roleDefinitionId: `/subscriptions/${args.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_BLOB_DATA_CONTRIBUTOR}`,
      principalId: spObjectId,
      principalType: "ServicePrincipal",
    },
  });
  if (!blobRa.ok && !/already exists|RoleAssignmentExists/i.test(blobRa.error)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[azure-provision] Granting Storage Blob Data Contributor failed (non-fatal): ${blobRa.error}`,
    );
  }

  return {
    ok: true,
    data: {
      clientId: appClientId,
      clientSecret,
      servicePrincipalObjectId: spObjectId,
      appDisplayName: appName,
    },
  };
}

/** Stable v5-ish GUID from a string, for idempotent role-assignment names. */
async function deterministicGuid(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const b = Array.from(new Uint8Array(buf))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`;
}
