/**
 * Deployment history — records every deploy attempt (via runDeploy) and lists
 * them for the Deployments page (one-click rollback / redeploy). Stores enough
 * of the spec to redeploy the same image with the same settings.
 *
 * NOTE: distinct from the legacy `deployments.ts` (Deployment/Pipeline rows).
 * This is the lightweight audit trail for the Deploy-My-App engine.
 */
import { prisma } from "@/lib/db/prisma";
import { Prisma, type DeploymentRecord } from "@prisma/client";
import { sanitizeAppName, type DeploySpec } from "./deploy-manifest";

export type DeployStatus = "succeeded" | "failed" | "rolled_back";

export async function recordDeployment(
  projectId: string,
  userId: string | null,
  target: { envKey: string },
  spec: DeploySpec,
  status: DeployStatus,
  detail?: string,
  source: "manual" | "scheduled" | "agent" | "watchdog" = "manual",
): Promise<void> {
  await prisma.deploymentRecord
    .create({
      data: {
        projectId,
        createdById: userId,
        envKey: target.envKey,
        appName: sanitizeAppName(spec.appName),
        image: spec.image,
        namespace: spec.namespace,
        containerPort: Math.max(1, spec.containerPort),
        replicas: Math.max(1, spec.replicas),
        envJson: (spec.env ?? []) as unknown as Prisma.InputJsonValue,
        expose: !!spec.expose,
        host: spec.host ?? null,
        status,
        detail: detail?.slice(0, 500) ?? null,
        source,
      },
    })
    .catch(() => {}); // history is best-effort — never fail a deploy over a log row
}

export async function listDeploymentRecords(projectId: string, limit = 100): Promise<DeploymentRecord[]> {
  return prisma.deploymentRecord.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: limit });
}

export async function getDeploymentRecord(projectId: string, id: string): Promise<DeploymentRecord | null> {
  return prisma.deploymentRecord.findFirst({ where: { projectId, id } });
}

/** Reconstruct a DeploySpec from a stored record (for redeploy). */
export function specFromRecord(r: DeploymentRecord): DeploySpec {
  return {
    appName: r.appName,
    image: r.image,
    namespace: r.namespace,
    replicas: Math.max(1, r.replicas),
    containerPort: Math.max(1, r.containerPort),
    env: Array.isArray(r.envJson) ? (r.envJson as Array<{ key: string; value: string }>) : [],
    expose: r.expose,
    host: r.host ?? undefined,
  };
}
