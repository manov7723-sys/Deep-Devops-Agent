/**
 * Ensure an Azure Terraform state backend exists (resource group + storage
 * account + blob container), using the env's stored Azure creds — no user
 * portal action. Idempotent: safe to call before every Terraform run. Persists
 * the resolved names onto the Env row so future runs pick them up via
 * `pickBackendForEnv`.
 *
 * Shared by:
 *   - the /azure-tfstate-provision REST endpoint (user-triggered)
 *   - the Terraform runner (auto-triggered on first Azure init)
 */
import { prisma } from "@/lib/db/prisma";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { setEnvAzureBackend } from "@/lib/devops/envs";
import { createHash } from "node:crypto";

const ARM = "https://management.azure.com";
const RG_API = "2021-04-01";
const STORAGE_API = "2023-01-01";
const POLL_MS = 4_000;
const CREATE_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_LOCATION = "eastus";

export type EnsureBackendResult =
  | {
      ok: true;
      backend: {
        resourceGroup: string;
        storageAccount: string;
        container: string;
        location: string;
      };
      steps: string[];
    }
  | { ok: false; code: string; message: string };

export type EnsureBackendInput = {
  projectId: string;
  envKey: string;
  envId: string;
  cloudProviderId: string;
  /** Optional overrides — used by the user-triggered REST route. Auto-generated
   *  names are used when not provided (agent flow). */
  resourceGroup?: string;
  storageAccount?: string;
  container?: string;
  location?: string;
};

/** Storage account names: 3-24 chars, lowercase letters+digits ONLY, globally
 *  unique across all of Azure. Hash the projectId+envId to keep it stable
 *  across reruns — same env always resolves to the same storage account. */
function autoStorageName(projectId: string, envId: string): string {
  const h = createHash("sha256").update(`${projectId}:${envId}`).digest("hex");
  // "dda" prefix + 13 hex chars = 16 chars total, well under 24.
  return `dda${h.slice(0, 13)}`;
}

export async function ensureAzureStateBackend(
  input: EnsureBackendInput,
): Promise<EnsureBackendResult> {
  const location = input.location?.trim() || DEFAULT_LOCATION;
  const resourceGroup = input.resourceGroup?.trim() || "rg-deepagent-state";
  const storageAccount =
    input.storageAccount?.trim() || autoStorageName(input.projectId, input.envId);
  const container = input.container?.trim() || "tfstate";

  const cp = await prisma.cloudProvider.findUnique({
    where: { id: input.cloudProviderId },
    select: { kind: true, accountRef: true },
  });
  if (cp?.kind !== "azure") {
    return { ok: false, code: "wrong_cloud", message: `Provider is not Azure (${cp?.kind}).` };
  }
  const subscriptionId = cp.accountRef;
  if (!subscriptionId) {
    return { ok: false, code: "no_subscription", message: "Azure provider has no subscription id." };
  }

  const tok = await getAzureAccessToken(input.cloudProviderId);
  if (!tok.ok) {
    return { ok: false, code: "auth_failed", message: `Couldn't authenticate to Azure: ${tok.error}` };
  }
  const authHeaders = { Authorization: `Bearer ${tok.accessToken}`, "Content-Type": "application/json" };
  const steps: string[] = [];

  // 1 — Resource group (idempotent PUT).
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}?api-version=${RG_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ location }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        code: "rg_failed",
        message: `Resource group PUT failed: ${body.slice(0, 500)}`,
      };
    }
    steps.push(res.status === 201 ? `created RG ${resourceGroup}` : `RG ${resourceGroup} exists`);
  }

  // 2 — Storage account (async: poll Azure-AsyncOperation).
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(storageAccount)}?api-version=${STORAGE_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
        properties: {
          allowBlobPublicAccess: false,
          minimumTlsVersion: "TLS1_2",
          allowSharedKeyAccess: true, // Terraform azurerm backend can then use shared-key OR AAD.
        },
      }),
      cache: "no-store",
    });
    if (res.status === 200) {
      steps.push(`storage ${storageAccount} exists`);
    } else if (res.status === 202) {
      const opUrl = res.headers.get("Azure-AsyncOperation") ?? res.headers.get("Location");
      if (!opUrl) {
        return {
          ok: false,
          code: "no_op_header",
          message: "Storage account create returned 202 with no polling URL.",
        };
      }
      const start = Date.now();
      let done = false;
      while (Date.now() - start < CREATE_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const pol = await fetch(opUrl, { headers: authHeaders, cache: "no-store" });
        if (!pol.ok) continue;
        const opState = (await pol.json().catch(() => ({}))) as {
          status?: string;
          error?: unknown;
        };
        if (opState.status === "Succeeded") {
          done = true;
          break;
        }
        if (opState.status === "Failed" || opState.status === "Canceled") {
          return {
            ok: false,
            code: "storage_op_failed",
            message: JSON.stringify(opState.error ?? opState).slice(0, 800),
          };
        }
      }
      if (!done) {
        return {
          ok: false,
          code: "storage_timeout",
          message: "Storage account create is still in progress on Azure's side.",
        };
      }
      steps.push(`created storage ${storageAccount}`);
    } else if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        code: "storage_failed",
        message: `Storage account PUT failed: ${body.slice(0, 700)}`,
      };
    } else {
      steps.push(`created storage ${storageAccount}`);
    }
  }

  // 3 — Blob container (idempotent PUT).
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(storageAccount)}/blobServices/default/containers/${encodeURIComponent(container)}?api-version=${STORAGE_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ properties: { publicAccess: "None" } }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        code: "container_failed",
        message: `Container PUT failed: ${body.slice(0, 500)}`,
      };
    }
    steps.push(res.status === 201 ? `created container ${container}` : `container ${container} exists`);
  }

  // 4 — Persist onto the env so future runs pick it up via pickBackendForEnv.
  await setEnvAzureBackend(input.projectId, input.envKey, {
    resourceGroup,
    storageAccount,
    container,
  }).catch(() => {});

  return {
    ok: true,
    backend: { resourceGroup, storageAccount, container, location },
    steps,
  };
}
