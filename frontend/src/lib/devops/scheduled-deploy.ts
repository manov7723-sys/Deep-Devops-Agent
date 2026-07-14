/**
 * Scheduled deployments — the agent lets a user "deploy later". We store the
 * deploy spec + a runAt time; the background scheduler runs any that are due via
 * the normal runDeploy path (which emails + posts to ChatOps on success/failure).
 */
import { prisma } from "@/lib/db/prisma";
import { Prisma, type ScheduledDeploy } from "@prisma/client";
import { runDeploy } from "./deploy";
import { sanitizeAppName, type DeploySpec } from "./deploy-manifest";
import { createScheduledDeployApproval } from "./deploy-approval";

export type ScheduleInput = {
  envKey: string;
  appName: string;
  image: string;
  containerPort?: number;
  replicas?: number;
  env?: Array<{ key: string; value: string }>;
  expose?: boolean;
  host?: string;
  namespace?: string;
};

export async function scheduleDeploy(
  projectId: string,
  userId: string,
  input: ScheduleInput,
  runAt: Date,
): Promise<ScheduledDeploy> {
  const namespace = (input.namespace || "").trim() || null;
  const sd = await prisma.scheduledDeploy.create({
    data: {
      projectId,
      createdById: userId,
      envKey: input.envKey,
      appName: input.appName,
      image: input.image,
      containerPort: Math.max(1, input.containerPort ?? 8080),
      replicas: Math.max(1, input.replicas ?? 1),
      envJson: (input.env ?? []) as unknown as Prisma.InputJsonValue,
      expose: !!input.expose,
      host: input.host ?? null,
      namespace,
      runAt,
      status: "pending",
      approved: false,
    },
  });

  // APPROVAL GATE (upfront): the scheduler won't run it until a human approves.
  const env = await prisma.env.findFirst({
    where: { projectId, key: input.envKey },
    select: { id: true, namespace: true, isProduction: true },
  });
  if (env) {
    const spec: DeploySpec = {
      appName: input.appName,
      image: input.image,
      namespace: namespace || env.namespace || "default",
      replicas: Math.max(1, input.replicas ?? 1),
      containerPort: Math.max(1, input.containerPort ?? 8080),
      env: input.env ?? [],
      expose: !!input.expose,
      host: input.host ?? undefined,
    };
    const { approvalId } = await createScheduledDeployApproval(
      projectId,
      {
        envKey: input.envKey,
        envId: env.id,
        namespace: spec.namespace,
        isProduction: env.isProduction,
      },
      spec,
      runAt,
      sd.id,
    );
    await prisma.scheduledDeploy
      .update({ where: { id: sd.id }, data: { approvalId } })
      .catch(() => {});
  }

  return sd;
}

export async function listScheduledDeploys(projectId: string): Promise<ScheduledDeploy[]> {
  return prisma.scheduledDeploy.findMany({
    where: { projectId },
    orderBy: { runAt: "asc" },
    take: 100,
  });
}

export async function cancelScheduledDeploy(projectId: string, id: string): Promise<boolean> {
  const r = await prisma.scheduledDeploy.updateMany({
    where: { projectId, id, status: "pending" },
    data: { status: "cancelled" },
  });
  return r.count > 0;
}

async function mark(id: string, status: string, result?: string): Promise<void> {
  await prisma.scheduledDeploy.update({
    where: { id },
    data: { status, result: result?.slice(0, 500) ?? null, ranAt: new Date() },
  });
}

async function executeScheduled(sd: ScheduledDeploy): Promise<void> {
  const env = await prisma.env.findFirst({
    where: { projectId: sd.projectId, key: sd.envKey },
    select: { id: true, namespace: true },
  });
  if (!env) return mark(sd.id, "failed", `Env "${sd.envKey}" not found or no cluster connected.`);
  const namespace = (sd.namespace || "").trim() || env.namespace || "default";
  const spec: DeploySpec = {
    appName: sd.appName,
    image: sd.image,
    namespace,
    replicas: Math.max(1, sd.replicas),
    containerPort: Math.max(1, sd.containerPort),
    env: Array.isArray(sd.envJson) ? (sd.envJson as Array<{ key: string; value: string }>) : [],
    expose: sd.expose,
    host: sd.host ?? undefined,
  };
  // runDeploy notifies (email + ChatOps) on success AND failure.
  const res = await runDeploy(
    { projectId: sd.projectId, userId: sd.createdById },
    { envKey: sd.envKey, envId: env.id, namespace },
    spec,
    { source: "scheduled" },
  );
  if (res.ok) await mark(sd.id, "done", `Deployed ${sanitizeAppName(sd.appName)} → ${sd.envKey}`);
  else await mark(sd.id, "failed", res.error);
}

/** Run every scheduled deploy that's due. Claims each row first to avoid double-runs. */
export async function runDueScheduledDeploys(now: Date): Promise<number> {
  // Only APPROVED scheduled deploys are eligible — unapproved ones wait (and a
  // rejected one is already status="cancelled", so it's excluded).
  const due = await prisma.scheduledDeploy.findMany({
    where: { status: "pending", approved: true, runAt: { lte: now } },
    take: 20,
  });
  let ran = 0;
  for (const sd of due) {
    const claimed = await prisma.scheduledDeploy.updateMany({
      where: { id: sd.id, status: "pending", approved: true },
      data: { status: "running" },
    });
    if (claimed.count === 0) continue; // another tick grabbed it
    try {
      await executeScheduled(sd);
      ran++;
    } catch (e) {
      await mark(sd.id, "failed", e instanceof Error ? e.message : "scheduled deploy failed");
    }
  }
  return ran;
}
