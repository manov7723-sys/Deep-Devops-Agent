import { prisma } from "@/lib/db/prisma";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createApproval } from "@/lib/devops/approvals";
import type { Tool } from "./types";

const STAGE_LABELS = ["Clone", "Build", "Plan", "Deploy", "Verify"] as const;

type TriggerOutput = {
  pipelineId: string;
  branch: string;
  sha: string;
  status: string;
  approvalId: string | null;
  requiresApproval: boolean;
};

/**
 * Manually trigger a deployment pipeline for a repo+branch on an env. Mirrors
 * what the (deleted) "Trigger deployment" modal did: creates a running
 * Pipeline with 5 stages, and — for production envs (or when the project
 * requires approval) — a pending Approval the pipeline waits on.
 */
export const triggerPipelineTool: Tool<
  { envKey: string; repoId: string; branch?: string; sha?: string },
  TriggerOutput
> = {
  name: "trigger_pipeline",
  description:
    "Manually trigger a deployment pipeline for a repo + branch on an environment. Production envs create a " +
    "pending approval the user must confirm — when approvalId comes back non-null, show it with an " +
    "```approval-card``` fence instead of telling the user to go find it.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Target environment key." },
      repoId: { type: "string", description: "Repo id — from list_project_repos." },
      branch: { type: "string", description: "Defaults to 'main'." },
      sha: {
        type: "string",
        description: "Optional commit sha; a random one is generated if omitted.",
      },
    },
    required: ["envKey", "repoId"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await envBySlugAndKey(ctx.projectId, input.envKey);
    if (!env) return { ok: false, error: "Environment not found." };

    const projectRepo = await prisma.projectRepo.findFirst({
      where: { projectId: ctx.projectId, repoId: input.repoId },
      select: { repoId: true },
    });
    if (!projectRepo)
      return {
        ok: false,
        error: "That repo isn't attached to this project. Use attach_project_repo first.",
      };

    const setting = await prisma.projectSetting.findUnique({
      where: { projectId: ctx.projectId },
      select: { requireApprovalRelease: true },
    });
    const requiresApproval = env.isProduction && (setting?.requireApprovalRelease ?? true);
    const branch = input.branch?.trim() || "main";
    const sha = input.sha?.trim() || crypto.randomUUID().replace(/-/g, "").slice(0, 40);

    const pipeline = await prisma.pipeline.create({
      data: {
        projectId: ctx.projectId,
        envId: env.id,
        repoId: input.repoId,
        branch,
        sha,
        status: "running",
        triggeredById: ctx.userId,
        progressPct: 0,
        attempt: 1,
        stages: {
          create: STAGE_LABELS.map((label, order) => ({
            label,
            order,
            status: order === 0 ? "run" : "wait",
          })),
        },
      },
      select: { id: true, sha: true, branch: true, status: true },
    });

    let approvalId: string | null = null;
    if (requiresApproval) {
      const approval = await createApproval({
        projectId: ctx.projectId,
        envId: env.id,
        title: `Deploy ${branch}@${sha.slice(0, 7)} to ${env.name}`,
        summary: `Pipeline ${pipeline.id.slice(0, 8)} is waiting for approval before applying changes to ${env.name}.`,
        changesSummary: "Production deploy",
        risk: "high",
        repoId: input.repoId,
        diff: [
          { kind: "comment", text: "No diff captured yet — agents will populate before applying." },
        ],
      });
      approvalId = approval.id;
    }

    return {
      ok: true,
      output: {
        pipelineId: pipeline.id,
        branch: pipeline.branch,
        sha: pipeline.sha,
        status: pipeline.status,
        approvalId,
        requiresApproval,
      },
    };
  },
};
