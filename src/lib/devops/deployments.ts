/**
 * Deployment triggering, listing, rollback. A trigger creates BOTH a Deployment
 * row (the immutable snapshot) and a Pipeline row (the in-progress run), wired
 * together via Pipeline.deploymentId / Deployment.pipeline.
 *
 * Pipeline status transitions are owned by `pipelines.ts`. When the pipeline
 * completes (succeeded), this module:
 *   - stamps Deployment.finishedAt + status
 *   - on success, points Env.currentDeploymentId at the new deployment
 *
 * Rollback creates a NEW Deployment record (status=running) with rollbackOfId
 * pointing at the chosen earlier deploy; the new run completes via the same
 * pipeline-status path.
 */
import { prisma } from "@/lib/db/prisma";

export type DeploymentRow = {
  id: string;
  envKey: string;
  sequence: number;
  status: "running" | "succeeded" | "failed" | "rolled_back";
  triggeredByName: string | null;
  rollbackOfSequence: number | null;
  note: string | null;
  repos: Array<{ repoId: string; fullName: string; sha: string; branch: string }>;
  pipelineId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

async function loadDeployment(id: string): Promise<DeploymentRow | null> {
  const d = await prisma.deployment.findUnique({
    where: { id },
    include: {
      env: { select: { key: true } },
      triggeredBy: { select: { name: true } },
      rollbackOf: { select: { sequence: true } },
      repos: { include: { repo: { select: { fullName: true } } } },
      pipeline: { select: { id: true } },
    },
  });
  if (!d) return null;
  return {
    id: d.id,
    envKey: d.env.key,
    sequence: d.sequence,
    status: d.status,
    triggeredByName: d.triggeredBy?.name ?? null,
    rollbackOfSequence: d.rollbackOf?.sequence ?? null,
    note: d.note,
    repos: d.repos.map((r) => ({
      repoId: r.repoId,
      fullName: r.repo.fullName,
      sha: r.sha,
      branch: r.branch,
    })),
    pipelineId: d.pipeline?.id ?? null,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

export async function listDeployments(envId: string): Promise<DeploymentRow[]> {
  const rows = await prisma.deployment.findMany({
    where: { envId },
    orderBy: { sequence: "desc" },
    select: { id: true },
  });
  const out: DeploymentRow[] = [];
  for (const r of rows) {
    const d = await loadDeployment(r.id);
    if (d) out.push(d);
  }
  return out;
}

export async function getDeploymentBySequence(envId: string, sequence: number) {
  const d = await prisma.deployment.findUnique({
    where: { envId_sequence: { envId, sequence } },
    select: { id: true },
  });
  if (!d) return null;
  return loadDeployment(d.id);
}

export type TriggerArgs = {
  envId: string;
  projectId: string;
  triggeredById: string;
  repos: Array<{ repoId: string; sha: string; branch: string }>;
  note?: string;
  stageLabels: string[];
};

export type TriggerResult =
  | { ok: true; deploymentId: string; pipelineId: string; sequence: number }
  | { ok: false; code: "repo_not_wired" };

/**
 * One transaction: claim next sequence, create Deployment + DeploymentRepos
 * + Pipeline + PipelineStages. Repos in the payload MUST already be wired to
 * the env (we don't allow an "incidental" deploy of an un-wired repo).
 */
export async function triggerDeployment(args: TriggerArgs): Promise<TriggerResult> {
  // Validate every repo is wired to this env.
  const wired = await prisma.envRepo.findMany({
    where: { envId: args.envId, repoId: { in: args.repos.map((r) => r.repoId) } },
    select: { repoId: true },
  });
  if (wired.length !== args.repos.length) return { ok: false, code: "repo_not_wired" };

  const result = await prisma.$transaction(async (tx) => {
    const last = await tx.deployment.findFirst({
      where: { envId: args.envId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? 0) + 1;

    // The first repo is the "primary" for the Pipeline row (the schema requires
    // one Repo on Pipeline). Stages mirror that primary run.
    const primary = args.repos[0]!;

    const deployment = await tx.deployment.create({
      data: {
        envId: args.envId,
        sequence,
        status: "running",
        triggeredById: args.triggeredById,
        note: args.note ?? null,
        repos: {
          create: args.repos.map((r) => ({ repoId: r.repoId, sha: r.sha, branch: r.branch })),
        },
      },
      select: { id: true },
    });

    const pipeline = await tx.pipeline.create({
      data: {
        projectId: args.projectId,
        envId: args.envId,
        repoId: primary.repoId,
        branch: primary.branch,
        sha: primary.sha,
        status: "running",
        triggeredById: args.triggeredById,
        deploymentId: deployment.id,
        stages: {
          create: args.stageLabels.map((label, idx) => ({
            label,
            status: idx === 0 ? "run" : "wait",
            order: idx,
          })),
        },
      },
      select: { id: true },
    });

    return { deploymentId: deployment.id, pipelineId: pipeline.id, sequence };
  });

  return { ok: true, ...result };
}

/**
 * Called by the pipeline-status module when a pipeline finishes. Updates the
 * deployment status + finishedAt; on success, re-points Env.currentDeploymentId.
 */
export async function syncDeploymentWithPipeline(
  deploymentId: string,
  pipelineStatus: "succeeded" | "failed",
): Promise<void> {
  const d = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { id: true, envId: true, status: true },
  });
  if (!d) return;
  if (d.status !== "running") return; // already terminal — don't clobber rollback paths

  if (pipelineStatus === "succeeded") {
    await prisma.$transaction([
      prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "succeeded", finishedAt: new Date() },
      }),
      prisma.env.update({
        where: { id: d.envId },
        data: { currentDeploymentId: deploymentId, updatedAt: new Date() },
      }),
    ]);
  } else {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "failed", finishedAt: new Date() },
    });
  }
}

export type RollbackResult =
  | { ok: true; deploymentId: string; sequence: number; pipelineId: string }
  | { ok: false; code: "target_not_found" | "target_not_succeeded" };

/**
 * Rollback to an earlier (succeeded) deployment. Creates a NEW deployment
 * snapshot referencing the SAME repo SHAs as the target, with rollbackOfId
 * pointing at the target. The new deployment's pipeline runs through the
 * normal stages so the audit trail records "what was applied to revert".
 */
export async function rollbackTo(
  envId: string,
  projectId: string,
  triggeredById: string,
  targetSequence: number,
  note?: string,
): Promise<RollbackResult> {
  const target = await prisma.deployment.findUnique({
    where: { envId_sequence: { envId, sequence: targetSequence } },
    include: { repos: true },
  });
  if (!target) return { ok: false, code: "target_not_found" };
  if (target.status !== "succeeded") return { ok: false, code: "target_not_succeeded" };

  const result = await prisma.$transaction(async (tx) => {
    const last = await tx.deployment.findFirst({
      where: { envId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? 0) + 1;
    const primary = target.repos[0]!;

    const deployment = await tx.deployment.create({
      data: {
        envId,
        sequence,
        status: "running",
        triggeredById,
        rollbackOfId: target.id,
        note: note ?? `Rollback to #${targetSequence}`,
        repos: {
          create: target.repos.map((r) => ({ repoId: r.repoId, sha: r.sha, branch: r.branch })),
        },
      },
      select: { id: true },
    });

    const pipeline = await tx.pipeline.create({
      data: {
        projectId,
        envId,
        repoId: primary.repoId,
        branch: primary.branch,
        sha: primary.sha,
        status: "running",
        triggeredById,
        deploymentId: deployment.id,
        stages: {
          create: [
            { label: "plan", status: "run", order: 0 },
            { label: "apply", status: "wait", order: 1 },
          ],
        },
      },
      select: { id: true },
    });

    return { deploymentId: deployment.id, pipelineId: pipeline.id, sequence };
  });

  return { ok: true, ...result };
}
