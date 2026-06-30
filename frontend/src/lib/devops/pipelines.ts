/**
 * Pipeline list/get/transition/retry. Status terminalisation also
 * synchronises the linked Deployment via syncDeploymentWithPipeline.
 */
import type { PipelineStatus, StageStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { syncDeploymentWithPipeline } from "./deployments";

export type PipelineRow = {
  id: string;
  envKey: string;
  repoFullName: string;
  branch: string;
  sha: string;
  status: PipelineStatus;
  triggeredByName: string | null;
  attempt: number;
  retryOfPipelineId: string | null;
  deploymentId: string | null;
  progressPct: number;
  durationSec: number | null;
  startedAt: string;
  finishedAt: string | null;
  stages: Array<{ id: string; label: string; status: StageStatus; order: number }>;
};

async function loadPipeline(id: string): Promise<PipelineRow | null> {
  const p = await prisma.pipeline.findUnique({
    where: { id },
    include: {
      env: { select: { key: true } },
      repo: { select: { fullName: true } },
      triggeredBy: { select: { name: true } },
      stages: { orderBy: { order: "asc" } },
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    envKey: p.env.key,
    repoFullName: p.repo.fullName,
    branch: p.branch,
    sha: p.sha,
    status: p.status,
    triggeredByName: p.triggeredBy?.name ?? null,
    attempt: p.attempt,
    retryOfPipelineId: p.retryOfId,
    deploymentId: p.deploymentId,
    progressPct: p.progressPct,
    durationSec: p.durationSec,
    startedAt: p.startedAt.toISOString(),
    finishedAt: p.finishedAt?.toISOString() ?? null,
    stages: p.stages.map((s) => ({ id: s.id, label: s.label, status: s.status, order: s.order })),
  };
}

export async function listPipelines(projectId: string, envId?: string): Promise<PipelineRow[]> {
  const rows = await prisma.pipeline.findMany({
    where: { projectId, ...(envId ? { envId } : {}) },
    orderBy: { startedAt: "desc" },
    select: { id: true },
    take: 100,
  });
  const out: PipelineRow[] = [];
  for (const r of rows) {
    const p = await loadPipeline(r.id);
    if (p) out.push(p);
  }
  return out;
}

export async function getPipeline(projectId: string, id: string): Promise<PipelineRow | null> {
  const p = await prisma.pipeline.findFirst({ where: { id, projectId }, select: { id: true } });
  if (!p) return null;
  return loadPipeline(p.id);
}

export type PatchPipelineArgs = {
  status?: PipelineStatus;
  progressPct?: number;
  stages?: Array<{ id: string; status: StageStatus }>;
};

export type PatchResult =
  | { ok: true; pipeline: PipelineRow }
  | { ok: false; code: "not_found" | "already_terminal" };

export async function patchPipeline(
  projectId: string,
  pipelineId: string,
  patch: PatchPipelineArgs,
): Promise<PatchResult> {
  const existing = await prisma.pipeline.findFirst({
    where: { id: pipelineId, projectId },
    select: { id: true, status: true, deploymentId: true, startedAt: true },
  });
  if (!existing) return { ok: false, code: "not_found" };
  if (existing.status !== "running" && patch.status && patch.status !== existing.status) {
    return { ok: false, code: "already_terminal" };
  }

  // Patch stages (per-row).
  if (patch.stages?.length) {
    await prisma.$transaction(
      patch.stages.map((s) =>
        prisma.pipelineStage.updateMany({
          where: { id: s.id, pipelineId },
          data: { status: s.status },
        }),
      ),
    );
  }

  const dataPipe: Parameters<typeof prisma.pipeline.update>[0]["data"] = {};
  if (patch.progressPct !== undefined) dataPipe.progressPct = patch.progressPct;
  if (patch.status) {
    dataPipe.status = patch.status;
    if (patch.status !== "running") {
      const finishedAt = new Date();
      dataPipe.finishedAt = finishedAt;
      dataPipe.durationSec = Math.round((finishedAt.getTime() - existing.startedAt.getTime()) / 1000);
      dataPipe.progressPct = 100;
    }
  }
  if (Object.keys(dataPipe).length > 0) {
    await prisma.pipeline.update({ where: { id: pipelineId }, data: dataPipe });
  }

  // Propagate terminal state to the linked deployment.
  if (patch.status && patch.status !== "running" && existing.deploymentId) {
    await syncDeploymentWithPipeline(existing.deploymentId, patch.status);
  }

  const pipeline = await loadPipeline(pipelineId);
  return { ok: true, pipeline: pipeline! };
}

export type RetryResult =
  | { ok: true; pipelineId: string }
  | { ok: false; code: "not_found" | "still_running" };

export async function retryPipeline(
  projectId: string,
  pipelineId: string,
  triggeredById: string,
): Promise<RetryResult> {
  const orig = await prisma.pipeline.findFirst({
    where: { id: pipelineId, projectId },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!orig) return { ok: false, code: "not_found" };
  if (orig.status === "running") return { ok: false, code: "still_running" };

  const retried = await prisma.pipeline.create({
    data: {
      projectId: orig.projectId,
      envId: orig.envId,
      repoId: orig.repoId,
      branch: orig.branch,
      sha: orig.sha,
      status: "running",
      triggeredById,
      attempt: orig.attempt + 1,
      retryOfId: orig.id,
      stages: {
        create: orig.stages.map((s, idx) => ({
          label: s.label,
          status: idx === 0 ? "run" : "wait",
          order: s.order,
        })),
      },
    },
    select: { id: true },
  });
  return { ok: true, pipelineId: retried.id };
}
