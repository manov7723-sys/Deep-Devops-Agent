/**
 * Live Cloud Stats — sync the CONNECTED CLUSTER NODES into the ManagedResource
 * table so the Compute tab shows real, actionable cluster nodes (not seed data
 * and not standalone cloud VMs — this is a Kubernetes-centric view).
 *
 * For every environment that has a kubeconfig wired, we list its nodes via the
 * existing k8s tool and upsert them as compute resources, replacing the prior
 * compute rows. Node cards are actionable (metrics / pods / cordon / drain).
 */
import { prisma } from "@/lib/db/prisma";
import { Prisma, type HealthStatus } from "@prisma/client";
import { listKubernetesResourcesTool } from "@/lib/agent/tools/list-kubernetes-resources";

export type SyncResult =
  | { ok: true; count: number; byEnv: Record<string, number>; errors: string[] }
  | { ok: false; error: string };

export async function syncCloudInventory(projectId: string, userId: string): Promise<SyncResult> {
  // Environments with a cluster connected (kubeconfig stored).
  const clusterEnvs = await prisma.env.findMany({
    where: { projectId, kubeconfigRef: { not: null } },
    select: {
      id: true,
      key: true,
      region: true,
      cloudProviderId: true,
      cloudProvider: { select: { kind: true } },
    },
  });
  if (!clusterEnvs.length) {
    return {
      ok: false,
      error: "No cluster is connected. Wire a kubeconfig on an environment (Clusters tab) first.",
    };
  }

  const ctx = { projectId, userId };
  const rows: Prisma.ManagedResourceCreateManyInput[] = [];
  const byEnv: Record<string, number> = {};
  const errors: string[] = [];

  for (const ce of clusterEnvs) {
    try {
      const r = await listKubernetesResourcesTool.execute({ envKey: ce.key, kind: "nodes" }, ctx);
      if (!r.ok) {
        errors.push(`${ce.key}: ${r.error}`);
        continue;
      }
      const cloud = (ce.cloudProvider?.kind ?? "k8s").toUpperCase();
      for (const n of r.output.items) {
        const ready = n.status === "Ready";
        const ver = n.extra?.version ? ` · ${n.extra.version}` : "";
        rows.push({
          projectId,
          envId: ce.id,
          cloudProviderId: ce.cloudProviderId,
          name: n.name,
          category: "compute",
          type: `Kubernetes node${ver}`,
          region: ce.region || null,
          status: (ready ? "ok" : "danger") as HealthStatus,
          attributes: { badges: [cloud, n.status ?? "?"], source: "live" } as Prisma.InputJsonValue,
        });
      }
      byEnv[ce.key] = r.output.items.length;
    } catch (e) {
      errors.push(`${ce.key}: ${e instanceof Error ? e.message : "list failed"}`);
    }
  }

  // Replace the project's compute rows with the freshly-fetched live nodes.
  await prisma.$transaction([
    prisma.managedResource.deleteMany({ where: { projectId, category: "compute" } }),
    ...(rows.length ? [prisma.managedResource.createMany({ data: rows })] : []),
  ]);

  return { ok: true, count: rows.length, byEnv, errors };
}
