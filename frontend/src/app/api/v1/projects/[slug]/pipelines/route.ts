import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { listPipelines } from "@/lib/devops/pipelines";
import { createApproval } from "@/lib/devops/approvals";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** List pipelines, optionally filtered by env key. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const envKey = new URL(req.url).searchParams.get("env");
  let envId: string | undefined;
  if (envKey && envKey !== "all") {
    const env = await envBySlugAndKey(gate.access.project.id, envKey);
    if (!env) return NextResponse.json([]);
    envId = env.id;
  }
  const pipelines = await listPipelines(gate.access.project.id, envId);
  return NextResponse.json(pipelines);
}

const TriggerBody = z.object({
  envKey: z.string().trim().min(1),
  repoId: z.string().uuid("Pick a repo from the dropdown"),
  branch: z.string().trim().min(1).max(120),
  sha: z.string().trim().min(7).max(64).optional(),
  /** Optional override of project default — "force require approval". */
  forceApproval: z.boolean().optional(),
});

const STAGE_LABELS = ["Clone", "Build", "Plan", "Deploy", "Verify"] as const;

/**
 * POST /projects/[slug]/pipelines — manually trigger a deployment pipeline.
 *
 * The pipeline starts in `running` state with 5 stages (clone → build → plan →
 * deploy → verify). If the env requires approval (env.isProduction OR
 * ProjectSetting.requireApprovalRelease), the call ALSO creates an `Approval`
 * row in `pending` state — the pipeline waits there until someone approves
 * via /approvals/[id]/decision.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) {
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  }
  const parsed = TriggerBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { envKey, repoId, branch, sha, forceApproval } = parsed.data;

  const env = await envBySlugAndKey(gate.access.project.id, envKey);
  if (!env) {
    return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  }

  // Repo must already be attached to the project (ProjectRepo row).
  const projectRepo = await prisma.projectRepo.findFirst({
    where: { projectId: gate.access.project.id, repoId },
    select: { repoId: true },
  });
  if (!projectRepo) {
    return NextResponse.json(
      {
        ok: false,
        code: "repo_not_in_project",
        message: "That repo isn't attached to this project.",
      },
      { status: 400 },
    );
  }

  const setting = await prisma.projectSetting.findUnique({
    where: { projectId: gate.access.project.id },
    select: { requireApprovalRelease: true, autoDeployNonProd: true },
  });
  // Production envs require approval whenever the project flag is on (default).
  // Non-prod envs are auto-deploy unless the caller explicitly forces approval.
  const requiresApproval =
    forceApproval === true || (env.isProduction && (setting?.requireApprovalRelease ?? true));

  const pipeline = await prisma.pipeline.create({
    data: {
      projectId: gate.access.project.id,
      envId: env.id,
      repoId,
      branch,
      sha: sha ?? generateShortSha(),
      status: "running",
      triggeredById: gate.access.session.userId,
      progressPct: 0,
      attempt: 1,
      stages: {
        create: STAGE_LABELS.map((label, order) => ({
          label,
          order,
          // First stage starts running; others queued.
          status: order === 0 ? "run" : "wait",
        })),
      },
    },
    select: { id: true, sha: true, branch: true, status: true, startedAt: true },
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "pipeline.triggered",
    targetType: "pipeline",
    targetId: pipeline.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey, repoId, branch, sha: pipeline.sha, requiresApproval },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "triggered",
    targetType: "pipeline",
    targetLabel: `${branch}@${pipeline.sha.slice(0, 7)} → ${env.name}`,
    envId: env.id,
    icon: "cicd",
  }).catch(() => {});

  let approvalId: string | null = null;
  if (requiresApproval) {
    const approval = await createApproval({
      projectId: gate.access.project.id,
      envId: env.id,
      title: `Deploy ${branch}@${pipeline.sha.slice(0, 7)} to ${env.name}`,
      summary: `Pipeline ${pipeline.id.slice(0, 8)} is waiting for approval before applying changes to ${env.name}.`,
      changesSummary: env.isProduction
        ? "Production deploy"
        : "Non-prod deploy gated by project policy",
      risk: env.isProduction ? "high" : "medium",
      repoId,
      diff: [
        { kind: "comment", text: "No diff captured yet — agents will populate before applying." },
      ],
    });
    approvalId = approval.id;
    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "approval.created",
      targetType: "approval",
      targetId: approval.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { pipelineId: pipeline.id, envKey, risk: approval.risk },
    });
    await recordActivity({
      projectId: gate.access.project.id,
      actorUserId: gate.access.session.userId,
      action: "requested approval",
      targetType: "approval",
      targetLabel: approval.title,
      envId: env.id,
      icon: "approve",
    }).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    pipeline: {
      id: pipeline.id,
      branch: pipeline.branch,
      sha: pipeline.sha,
      status: pipeline.status,
      startedAt: pipeline.startedAt.toISOString(),
    },
    approval: approvalId ? { id: approvalId, status: "pending" } : null,
    requiresApproval,
  });
}

/** A short hex sha for triggered runs when none is supplied. */
function generateShortSha(): string {
  // 40-char hex is what GitHub uses; we generate one client-side-equivalent
  // using crypto.randomUUID without dashes, truncated.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 40);
}
