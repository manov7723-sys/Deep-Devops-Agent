import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Envs
// ──────────────────────────────────────────────────────────────────
export const EnvSummary = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  isProduction: z.boolean(),
  autoDeploy: z.boolean(),
  region: z.string().nullable(),
  terraformWorkspace: z.string().nullable(),
  promotionRank: z.number().int(),
  cloudProviderId: z.string().nullable(),
  currentDeploymentId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EnvSummary = z.infer<typeof EnvSummary>;

export const CreateEnvRequest = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "Key must be lowercase letters, digits, '-' or '_'"),
  name: z.string().trim().min(1).max(80),
  isProduction: z.boolean().default(false),
  autoDeploy: z.boolean().default(false),
  cloudProviderId: z.string().min(1).optional(),
  region: z.string().trim().max(40).optional(),
  terraformWorkspace: z.string().trim().max(120).optional(),
  url: z.string().url().optional(),
  promotionRank: z.number().int().min(0).max(99).default(0),
  /** Optional raw kubeconfig YAML. Encrypted at rest. */
  kubeconfig: z
    .string()
    .max(64 * 1024)
    .optional(),
  /** Defaults to "default" if omitted. */
  namespace: z.string().trim().min(1).max(120).optional(),
});
export type CreateEnvRequest = z.infer<typeof CreateEnvRequest>;

export const UpdateEnvRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isProduction: z.boolean().optional(),
    autoDeploy: z.boolean().optional(),
    cloudProviderId: z.string().min(1).nullable().optional(),
    region: z.string().trim().max(40).optional(),
    terraformWorkspace: z.string().trim().max(120).optional(),
    url: z.string().url().nullable().optional(),
    promotionRank: z.number().int().min(0).max(99).optional(),
    /** Pass the raw kubeconfig YAML — the server encrypts before storing.
     *  Pass `""` to clear an existing kubeconfig. */
    kubeconfig: z
      .string()
      .max(64 * 1024)
      .optional(),
    namespace: z.string().trim().min(1).max(120).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type UpdateEnvRequest = z.infer<typeof UpdateEnvRequest>;

export const WireRepoRequest = z.object({
  repoId: z.string().min(1),
  branch: z.string().trim().min(1).max(120).default("main"),
  autoDeploy: z.boolean().default(false),
});
export type WireRepoRequest = z.infer<typeof WireRepoRequest>;

// ──────────────────────────────────────────────────────────────────
// Deployments
// ──────────────────────────────────────────────────────────────────
export const DeploymentStatusApi = z.enum(["running", "succeeded", "failed", "rolled_back"]);
export type DeploymentStatusApi = z.infer<typeof DeploymentStatusApi>;

export const DeploymentSummary = z.object({
  id: z.string(),
  envKey: z.string(),
  sequence: z.number().int(),
  status: DeploymentStatusApi,
  triggeredByName: z.string().nullable(),
  rollbackOfSequence: z.number().int().nullable(),
  note: z.string().nullable(),
  repos: z.array(
    z.object({
      repoId: z.string(),
      fullName: z.string(),
      sha: z.string(),
      branch: z.string(),
    }),
  ),
  pipelineId: z.string().nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type DeploymentSummary = z.infer<typeof DeploymentSummary>;

export const TriggerDeploymentRequest = z.object({
  // One sha per repo wired to this env. Repos not present default to the env's branch tip,
  // but for the API surface we require explicit shas to keep the snapshot deterministic.
  repos: z
    .array(
      z.object({
        repoId: z.string().min(1),
        sha: z.string().trim().min(7).max(64),
        branch: z.string().trim().min(1).max(120),
      }),
    )
    .min(1, "At least one repo SHA is required"),
  note: z.string().trim().max(280).optional(),
  // The default pipeline stages — runners override via PATCH later.
  stages: z.array(z.string().trim().min(1).max(40)).optional().default(["build", "test", "deploy"]),
});
export type TriggerDeploymentRequest = z.infer<typeof TriggerDeploymentRequest>;

export const RollbackRequest = z.object({
  note: z.string().trim().max(280).optional(),
});
export type RollbackRequest = z.infer<typeof RollbackRequest>;

// ──────────────────────────────────────────────────────────────────
// Pipelines
// ──────────────────────────────────────────────────────────────────
export const PipelineStatusApi = z.enum(["running", "succeeded", "failed"]);
export type PipelineStatusApi = z.infer<typeof PipelineStatusApi>;

export const PipelineStageStatusApi = z.enum(["ok", "fail", "run", "wait"]);

export const PipelineSummary = z.object({
  id: z.string(),
  envKey: z.string(),
  repoFullName: z.string(),
  branch: z.string(),
  sha: z.string(),
  status: PipelineStatusApi,
  triggeredByName: z.string().nullable(),
  attempt: z.number().int(),
  retryOfPipelineId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  progressPct: z.number().int(),
  durationSec: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  stages: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: PipelineStageStatusApi,
      order: z.number().int(),
    }),
  ),
});
export type PipelineSummary = z.infer<typeof PipelineSummary>;

export const PatchPipelineRequest = z
  .object({
    status: PipelineStatusApi.optional(),
    progressPct: z.number().int().min(0).max(100).optional(),
    stages: z
      .array(
        z.object({
          id: z.string().min(1),
          status: PipelineStageStatusApi,
        }),
      )
      .optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchPipelineRequest = z.infer<typeof PatchPipelineRequest>;

// ──────────────────────────────────────────────────────────────────
// Approvals
// ──────────────────────────────────────────────────────────────────
export const ApprovalRiskApi = z.enum(["low", "medium", "high"]);
export const ApprovalStatusApi = z.enum(["pending", "approved", "rejected"]);
export const DiffKindApi = z.enum(["add", "remove", "comment"]);

export const ApprovalSummary = z.object({
  id: z.string(),
  envKey: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  changesSummary: z.string().nullable(),
  risk: ApprovalRiskApi,
  status: ApprovalStatusApi,
  decidedByName: z.string().nullable(),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  diff: z.array(
    z.object({
      kind: DiffKindApi,
      text: z.string(),
      order: z.number().int(),
    }),
  ),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummary>;

export const CreateApprovalRequest = z.object({
  envKey: z.string().trim().min(1),
  title: z.string().trim().min(1).max(140),
  summary: z.string().trim().max(500).optional(),
  changesSummary: z.string().trim().max(140).optional(),
  risk: ApprovalRiskApi.default("medium"),
  repoId: z.string().min(1).optional(),
  diff: z
    .array(
      z.object({
        kind: DiffKindApi,
        text: z.string().min(1).max(500),
      }),
    )
    .default([]),
});
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequest>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(["approve", "reject"]),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;
