import { prisma } from "@/lib/db/prisma";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import type { Tool } from "./types";

type Input = Record<string, never>;
type VmItem = {
  name: string;
  zone: string;
  machineType?: string;
  status: string;
  internalIp?: string;
  externalIp?: string;
};
type Output = { gcpProject: string; count: number; vms: VmItem[] };

/** Find the project's GCP provider (per-project isolation). accountRef = GCP project id. */
async function resolveGcpProvider(projectId: string): Promise<{ id: string; gcpProject: string } | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "gcp" },
    select: { id: true, accountRef: true },
    orderBy: { createdAt: "desc" },
  });
  return cp ? { id: cp.id, gcpProject: cp.accountRef } : null;
}

/**
 * List Google Compute Engine VM instances in the project's connected GCP
 * project — the GCP counterpart of list_ec2_instances / list_azure_vms. Uses the
 * aggregated list (all zones at once). Read-only.
 */
export const listGcpInstancesTool: Tool<Input, Output> = {
  name: "list_gcp_instances",
  description:
    "List Google Cloud Compute Engine VM instances in the project's connected GCP project. Use this for " +
    "'list my GCP VMs / compute instances', 'what VMs are running in Google Cloud'. Read-only — never " +
    "starts/stops/deletes anything. Requires a GCP account connected (Sign in with Google on the Cloud " +
    "providers tab).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const prov = await resolveGcpProvider(ctx.projectId);
    if (!prov) {
      return {
        ok: false,
        error: "No GCP account is connected to this project. Connect one with 'Sign in with Google' on the Cloud providers tab first.",
      };
    }
    const tok = await getGcpAccessToken(prov.id);
    if (!tok.ok) return { ok: false, error: `Could not authenticate to GCP: ${tok.error}` };

    const url = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(prov.gcpProject)}/aggregated/instances`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` }, cache: "no-store" });
    } catch (err) {
      return { ok: false, error: `Network error reaching GCP: ${err instanceof Error ? err.message : "unknown"}` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 403 usually means the Compute Engine API isn't enabled on the project.
      if (res.status === 403 && /Compute Engine API has not been used|SERVICE_DISABLED/i.test(body)) {
        return {
          ok: false,
          error: `The Compute Engine API isn't enabled for GCP project "${prov.gcpProject}". Enable it at console.cloud.google.com/apis/library/compute.googleapis.com then retry.`,
        };
      }
      return { ok: false, error: `GCP returned ${res.status} listing instances: ${body.slice(0, 220)}` };
    }

    const data = (await res.json().catch(() => ({}))) as {
      items?: Record<
        string,
        {
          instances?: Array<{
            name: string;
            zone?: string;
            machineType?: string;
            status: string;
            networkInterfaces?: Array<{ networkIP?: string; accessConfigs?: Array<{ natIP?: string }> }>;
          }>;
        }
      >;
    };

    const vms: VmItem[] = [];
    for (const [zoneKey, group] of Object.entries(data.items ?? {})) {
      for (const inst of group.instances ?? []) {
        const ni = inst.networkInterfaces?.[0];
        vms.push({
          name: inst.name,
          zone: (inst.zone || zoneKey).split("/").pop() ?? "",
          machineType: inst.machineType?.split("/").pop(),
          status: inst.status,
          internalIp: ni?.networkIP,
          externalIp: ni?.accessConfigs?.[0]?.natIP,
        });
      }
    }
    return { ok: true, output: { gcpProject: prov.gcpProject, count: vms.length, vms } };
  },
};
