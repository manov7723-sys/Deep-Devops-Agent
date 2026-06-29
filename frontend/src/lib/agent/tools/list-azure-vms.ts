import { prisma } from "@/lib/db/prisma";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import type { Tool } from "./types";

type Input = {
  /** Optional: only list VMs in this resource group. */
  resourceGroup?: string;
};

type VmItem = {
  name: string;
  location: string;
  size?: string;
  resourceGroup: string;
  osType?: string;
  provisioningState?: string;
};

type Output = {
  subscriptionId: string;
  count: number;
  vms: VmItem[];
};

/** Find the Azure provider for THIS project (per-project isolation). */
async function resolveAzureProvider(projectId: string): Promise<{ id: string; subscriptionId: string } | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true, accountRef: true },
    orderBy: { createdAt: "desc" },
  });
  return cp ? { id: cp.id, subscriptionId: cp.accountRef } : null;
}

/**
 * List Azure virtual machines in the project's connected Azure subscription —
 * the Azure counterpart of list_ec2_instances. Uses the project's Azure
 * provider (OAuth refresh token or service principal) to mint an ARM token and
 * query Microsoft.Compute. Read-only.
 */
export const listAzureVmsTool: Tool<Input, Output> = {
  name: "list_azure_vms",
  description:
    "List Azure virtual machines (VMs) in the project's connected Azure subscription. Use this to answer " +
    "'list my Azure VMs', 'show my virtual machines', 'what VMs are running in Azure'. Read-only — never " +
    "starts/stops/deletes anything. Requires an Azure account connected (Sign in with Microsoft on the " +
    "Cloud providers tab). Optionally filter by resource group.",
  inputSchema: {
    type: "object",
    properties: {
      resourceGroup: {
        type: "string",
        description: "Optional resource group name to filter by.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const prov = await resolveAzureProvider(ctx.projectId);
    if (!prov) {
      return {
        ok: false,
        error:
          "No Azure account is connected to this project. Connect one with 'Sign in with Microsoft' on the Cloud providers tab first.",
      };
    }

    const tok = await getAzureAccessToken(prov.id);
    if (!tok.ok) {
      return { ok: false, error: `Could not authenticate to Azure: ${tok.error}` };
    }

    const rg = input.resourceGroup?.trim();
    const url = rg
      ? `https://management.azure.com/subscriptions/${prov.subscriptionId}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.Compute/virtualMachines?api-version=2023-07-01`
      : `https://management.azure.com/subscriptions/${prov.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2023-07-01`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` }, cache: "no-store" });
    } catch (err) {
      return { ok: false, error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Azure returned ${res.status} listing VMs: ${body.slice(0, 200)}` };
    }

    const data = (await res.json().catch(() => ({}))) as {
      value?: Array<{
        id: string;
        name: string;
        location: string;
        properties?: {
          hardwareProfile?: { vmSize?: string };
          provisioningState?: string;
          storageProfile?: { osDisk?: { osType?: string } };
        };
      }>;
    };

    const vms: VmItem[] = (data.value ?? []).map((vm) => ({
      name: vm.name,
      location: vm.location,
      size: vm.properties?.hardwareProfile?.vmSize,
      resourceGroup: vm.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
      osType: vm.properties?.storageProfile?.osDisk?.osType,
      provisioningState: vm.properties?.provisioningState,
    }));

    return { ok: true, output: { subscriptionId: prov.subscriptionId, count: vms.length, vms } };
  },
};
