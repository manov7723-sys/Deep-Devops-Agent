import { prisma } from "@/lib/db/prisma";
import { attachAcrToAksCluster, parseAksClusterRef } from "@/lib/cloud/azure-acr";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAksClusters } from "@/lib/cloud/azure-arm";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

/**
 * Attach one or more ACRs to an env's AKS cluster so kubelet can pull images
 * without a per-namespace imagePullSecret. The Azure fix for ImagePullBackOff
 * on a cluster whose Deployments reference an ACR the cluster hasn't been
 * granted AcrPull on.
 *
 * Auto-discovers the target AKS cluster from the env's stored kubeconfig, or
 * falls back to `listAksClusters` on the connected subscription (uses the
 * single cluster if one, returns candidates if many). Auto-discovers ACR
 * resource groups by matching the ACR name in the subscription — the caller
 * only has to name the ACRs, not their locations.
 */
export const attachAcrToAksTool: Tool<
  {
    envKey: string;
    /** ACR names to attach — usually one per service (backend + frontend). */
    acrNames: string[];
    /** Explicit cluster override if the env's kubeconfig can't be parsed. */
    clusterName?: string;
    resourceGroup?: string;
  },
  {
    clusterName: string;
    resourceGroup: string;
    attached: Array<{ acr: string; resourceGroup: string; kubeletObjectId: string }>;
    failed: Array<{ acr: string; error: string }>;
    note: string;
  }
> = {
  name: "attach_acr_to_aks",
  description:
    "Grant an env's AKS cluster's kubelet identity `AcrPull` on the named ACRs, so pods stop getting ImagePullBackOff. Use as soon as a deploy's pods report ImagePullBackOff and `kubectl describe pod` shows '401 unauthorized' / 'authentication required' from the registry. The app CAN do this via ARM — do NOT tell the user to run `az aks update --attach-acr` or grant AcrPull via Portal. Idempotent (RoleAssignmentExists = success). ~30s per ACR + a few more seconds for kubelet to notice the new permission.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose AKS cluster's kubelet to grant AcrPull on.",
      },
      acrNames: {
        type: "array",
        items: { type: "string" },
        description:
          "ACR names to attach (name only, not full loginServer). Usually one per service — e.g. ['aiagenticappbackend','aiagenticappfrontend'].",
      },
      clusterName: {
        type: "string",
        description:
          "Explicit AKS cluster name. Use only when the env's kubeconfig can't be parsed AND listAksClusters returned multiple candidates.",
      },
      resourceGroup: {
        type: "string",
        description: "Resource group of the explicit cluster.",
      },
    },
    required: ["envKey", "acrNames"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };
    if (!env.cloudProviderId) {
      return { ok: false, error: `Env "${input.envKey}" has no cloud provider connected.` };
    }
    const cp = await prisma.cloudProvider.findFirst({
      where: { id: env.cloudProviderId, kind: "azure" },
      select: { id: true, accountRef: true },
    });
    if (!cp) {
      return {
        ok: false,
        error: `Env "${input.envKey}" isn't wired to an Azure cloud provider.`,
      };
    }
    const tok = await getAzureAccessToken(cp.id);
    if (!tok.ok) return { ok: false, error: `Azure token unavailable: ${tok.error}` };

    // Resolve the AKS cluster — kubeconfig parse first, list fallback (same
    // policy as grant_aks_access, so behaviour stays consistent).
    let clusterName = input.clusterName?.trim() || "";
    let resourceGroup = input.resourceGroup?.trim() || "";
    if (!clusterName || !resourceGroup) {
      const kcfg = await getKubeconfigForEnv(env.id).catch(() => null);
      if (kcfg && kcfg.ok) {
        try {
          const { readFile } = await import("node:fs/promises");
          const text = await readFile(kcfg.handle.path, "utf8");
          const parsed = parseAksClusterRef(text);
          if (parsed?.clusterName) clusterName = parsed.clusterName;
          if (parsed?.resourceGroup) resourceGroup = parsed.resourceGroup;
        } finally {
          await kcfg.handle.cleanup().catch(() => {});
        }
      }
    }
    if (!clusterName || !resourceGroup) {
      if (!cp.accountRef)
        return { ok: false, error: `Azure provider has no subscription id stored.` };
      const list = await listAksClusters(tok.accessToken, cp.accountRef);
      if (!list.ok) return { ok: false, error: `Cluster list failed: ${list.error}` };
      if (list.clusters.length === 1) {
        clusterName = list.clusters[0].name;
        resourceGroup = list.clusters[0].resourceGroup;
      } else if (list.clusters.length === 0) {
        return { ok: false, error: `No AKS clusters exist in this Azure subscription.` };
      } else {
        return {
          ok: false,
          error: `Multiple AKS clusters — pass clusterName + resourceGroup explicitly. Candidates: ${list.clusters
            .map((c) => `${c.name} (${c.resourceGroup})`)
            .join(", ")}.`,
        };
      }
    }

    // ACR resource group discovery — most ACRs share the cluster's RG, but not
    // always. List once and map by name.
    let acrRgByName = new Map<string, string>();
    if (cp.accountRef) {
      const { armFetch, listAzureStorageAccounts: _ } = await import("@/lib/cloud/azure-arm").then(
        (m) => ({ armFetch: null as unknown, listAzureStorageAccounts: m.listAzureStorageAccounts }),
      );
      void _;
      // ARM: list registries under the sub.
      const httpsReq = await fetch(
        `https://management.azure.com/subscriptions/${cp.accountRef}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-11-01-preview`,
        { headers: { Authorization: `Bearer ${tok.accessToken}` } },
      );
      if (httpsReq.ok) {
        const j = (await httpsReq.json()) as {
          value?: Array<{ name?: string; id?: string }>;
        };
        for (const r of j.value ?? []) {
          const m = (r.id ?? "").match(/\/resourceGroups\/([^/]+)/i);
          if (r.name && m) acrRgByName.set(r.name.toLowerCase(), m[1]);
        }
      }
    }

    const attached: Array<{ acr: string; resourceGroup: string; kubeletObjectId: string }> = [];
    const failed: Array<{ acr: string; error: string }> = [];
    for (const acrName of input.acrNames) {
      const acrRg = acrRgByName.get(acrName.toLowerCase()) ?? resourceGroup;
      const res = await attachAcrToAksCluster({
        cloudProviderId: cp.id,
        resourceGroup,
        clusterName,
        acrName,
        acrResourceGroup: acrRg,
      });
      if (res.ok) {
        attached.push({ acr: acrName, resourceGroup: acrRg, kubeletObjectId: res.data.kubeletObjectId });
      } else {
        failed.push({ acr: acrName, error: res.error });
      }
    }

    if (attached.length === 0) {
      return {
        ok: false,
        error: `Couldn't attach any ACR. ${failed.map((f) => `${f.acr}: ${f.error}`).join("; ")}`,
      };
    }

    return {
      ok: true,
      output: {
        clusterName,
        resourceGroup,
        attached,
        failed,
        note:
          `Granted AKS kubelet AcrPull on ${attached.map((a) => a.acr).join(", ")}. ` +
          `Delete the ImagePullBackOff pods (kubectl deletes trigger a fresh pull) or wait ~1 minute — kubelet ` +
          `retries backoff up to ~5 minutes.` +
          (failed.length
            ? ` FAILED: ${failed.map((f) => `${f.acr} (${f.error})`).join("; ")}.`
            : ""),
      },
    };
  },
};
