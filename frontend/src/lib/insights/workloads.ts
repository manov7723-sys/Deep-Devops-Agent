/**
 * Workloads = ManagedResource (the unified workload+cloud-resource model).
 * Each is scoped to an Env and optionally pinned to a CloudProvider; the
 * `provisionedBy` discriminator records who applied it.
 */
import type { HealthStatus, ManagedResource, ResourceCategory } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type WorkloadRow = {
  id: string;
  envKey: string;
  name: string;
  category: ResourceCategory;
  type: string;
  provisionedBy: "terraform" | "kubernetes" | "manual";
  enabled: boolean;
  region: string | null;
  status: HealthStatus;
  cpuPct: number | null;
  memPct: number | null;
  replicasReady: number | null;
  replicasDesired: number | null;
  cloudProviderId: string | null;
  createdAt: string;
  updatedAt: string;
};

function row(r: ManagedResource & { env: { key: string } }): WorkloadRow {
  return {
    id: r.id,
    envKey: r.env.key,
    name: r.name,
    category: r.category,
    type: r.type,
    provisionedBy: r.provisionedBy,
    enabled: r.enabled,
    region: r.region,
    status: r.status,
    cpuPct: r.cpuPct,
    memPct: r.memPct,
    replicasReady: r.replicasReady,
    replicasDesired: r.replicasDesired,
    cloudProviderId: r.cloudProviderId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listWorkloads(
  projectId: string,
  filter: { envId?: string; category?: ResourceCategory } = {},
): Promise<WorkloadRow[]> {
  const rows = await prisma.managedResource.findMany({
    where: {
      projectId,
      ...(filter.envId ? { envId: filter.envId } : {}),
      ...(filter.category ? { category: filter.category } : {}),
    },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { env: { select: { key: true } } },
  });
  return rows.map(row);
}

export type CreateWorkloadArgs = {
  projectId: string;
  envId: string;
  name: string;
  category: ResourceCategory;
  type: string;
  provisionedBy: "terraform" | "kubernetes" | "manual";
  enabled: boolean;
  region?: string;
  cpuPct?: number;
  memPct?: number;
  replicasReady?: number;
  replicasDesired?: number;
  cloudProviderId?: string;
};

export async function createWorkload(args: CreateWorkloadArgs): Promise<WorkloadRow> {
  const created = await prisma.managedResource.create({
    data: {
      projectId: args.projectId,
      envId: args.envId,
      name: args.name,
      category: args.category,
      type: args.type,
      provisionedBy: args.provisionedBy,
      enabled: args.enabled,
      region: args.region ?? null,
      cpuPct: args.cpuPct ?? null,
      memPct: args.memPct ?? null,
      replicasReady: args.replicasReady ?? null,
      replicasDesired: args.replicasDesired ?? null,
      cloudProviderId: args.cloudProviderId ?? null,
    },
    include: { env: { select: { key: true } } },
  });
  return row(created);
}

export type PatchWorkloadArgs = Partial<{
  name: string;
  type: string;
  enabled: boolean;
  region: string;
  status: HealthStatus;
  cpuPct: number | null;
  memPct: number | null;
  replicasReady: number | null;
  replicasDesired: number | null;
}>;

export type PatchWorkloadResult =
  | { ok: true; workload: WorkloadRow }
  | { ok: false; code: "not_found" };

export async function patchWorkload(
  projectId: string,
  id: string,
  patch: PatchWorkloadArgs,
): Promise<PatchWorkloadResult> {
  const existing = await prisma.managedResource.findFirst({ where: { id, projectId }, select: { id: true } });
  if (!existing) return { ok: false, code: "not_found" };

  const updated = await prisma.managedResource.update({
    where: { id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.region !== undefined && { region: patch.region }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.cpuPct !== undefined && { cpuPct: patch.cpuPct }),
      ...(patch.memPct !== undefined && { memPct: patch.memPct }),
      ...(patch.replicasReady !== undefined && { replicasReady: patch.replicasReady }),
      ...(patch.replicasDesired !== undefined && { replicasDesired: patch.replicasDesired }),
    },
    include: { env: { select: { key: true } } },
  });
  return { ok: true, workload: row(updated) };
}

export async function deleteWorkload(projectId: string, id: string): Promise<boolean> {
  const { count } = await prisma.managedResource.deleteMany({ where: { id, projectId } });
  return count > 0;
}
