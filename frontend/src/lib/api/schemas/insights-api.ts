import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Cost
// ──────────────────────────────────────────────────────────────────
export const CostByEnvRow = z.object({
  envKey: z.string().nullable(),
  label: z.string(),
  amountCents: z.number().int(),
});

export const CostByServiceRow = z.object({
  service: z.string(),
  amountCents: z.number().int(),
  pct: z.number().int().nullable(),
});

export const CostSnapshotSummary = z.object({
  id: z.string(),
  periodStart: z.string().datetime(),
  totalCents: z.number().int(),
  forecastCents: z.number().int().nullable(),
  budgetCents: z.number().int().nullable(),
  savingsCents: z.number().int().nullable(),
  untaggedCents: z.number().int().nullable(),
  byEnv: z.array(CostByEnvRow),
  byService: z.array(CostByServiceRow),
  createdAt: z.string().datetime(),
});
export type CostSnapshotSummary = z.infer<typeof CostSnapshotSummary>;

export const CostTrendPointApi = z.object({
  monthStart: z.string().datetime(),
  amountCents: z.number().int(),
});
export type CostTrendPointApi = z.infer<typeof CostTrendPointApi>;

export const CreateCostSnapshotRequest = z.object({
  periodStart: z.string().datetime(),
  totalCents: z.number().int().min(0),
  forecastCents: z.number().int().min(0).optional(),
  budgetCents: z.number().int().min(0).optional(),
  savingsCents: z.number().int().min(0).optional(),
  untaggedCents: z.number().int().min(0).optional(),
  byEnv: z
    .array(
      z.object({
        envKey: z.string().min(1).nullable().optional(),
        label: z.string().trim().min(1).max(80),
        amountCents: z.number().int().min(0),
      }),
    )
    .default([]),
  byService: z
    .array(
      z.object({
        service: z.string().trim().min(1).max(80),
        amountCents: z.number().int().min(0),
        pct: z.number().int().min(0).max(100).optional(),
      }),
    )
    .default([]),
});
export type CreateCostSnapshotRequest = z.infer<typeof CreateCostSnapshotRequest>;

// ──────────────────────────────────────────────────────────────────
// Observability
// ──────────────────────────────────────────────────────────────────
export const KpiToneApi = z.enum(["ok", "warn", "danger"]);

export const ObservabilityKpiSummary = z.object({
  id: z.string(),
  envKey: z.string().nullable(),
  name: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  tone: KpiToneApi,
  series: z.array(z.number().int()),
  capturedAt: z.string().datetime(),
});
export type ObservabilityKpiSummary = z.infer<typeof ObservabilityKpiSummary>;

export const CreateKpiRequest = z.object({
  envKey: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(40),
  unit: z.string().trim().max(20).optional(),
  tone: KpiToneApi.default("ok"),
  series: z.array(z.number().int()).max(60).default([]),
});
export type CreateKpiRequest = z.infer<typeof CreateKpiRequest>;

export const PrometheusTargetSummary = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["up", "down"]),
  series: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});

export const CreateTargetRequest = z.object({
  name: z.string().trim().min(1).max(80),
  status: z.enum(["up", "down"]).default("up"),
  series: z.number().int().min(0).optional(),
});
export type CreateTargetRequest = z.infer<typeof CreateTargetRequest>;

export const GrafanaDashboardSummary = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const CreateDashboardRequest = z.object({
  title: z.string().trim().min(1).max(120),
  url: z.string().url().optional(),
});
export type CreateDashboardRequest = z.infer<typeof CreateDashboardRequest>;

// ──────────────────────────────────────────────────────────────────
// Workloads (ManagedResource)
// ──────────────────────────────────────────────────────────────────
export const ResourceCategoryApi = z.enum([
  "compute",
  "network",
  "storage",
  "data",
  "cache",
  "security",
  "other",
]);
export type ResourceCategoryApi = z.infer<typeof ResourceCategoryApi>;

export const ProvisionedByApi = z.enum(["terraform", "kubernetes", "manual"]);

export const WorkloadSummary = z.object({
  id: z.string(),
  envKey: z.string(),
  name: z.string(),
  category: ResourceCategoryApi,
  type: z.string(),
  provisionedBy: ProvisionedByApi,
  enabled: z.boolean(),
  region: z.string().nullable(),
  status: z.enum(["ok", "warn", "danger"]),
  cpuPct: z.number().int().nullable(),
  memPct: z.number().int().nullable(),
  replicasReady: z.number().int().nullable(),
  replicasDesired: z.number().int().nullable(),
  cloudProviderId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkloadSummary = z.infer<typeof WorkloadSummary>;

export const CreateWorkloadRequest = z.object({
  envKey: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  category: ResourceCategoryApi,
  type: z.string().trim().min(1).max(120),
  provisionedBy: ProvisionedByApi.default("terraform"),
  enabled: z.boolean().default(true),
  region: z.string().trim().max(40).optional(),
  cpuPct: z.number().int().min(0).max(100).optional(),
  memPct: z.number().int().min(0).max(100).optional(),
  replicasReady: z.number().int().min(0).optional(),
  replicasDesired: z.number().int().min(0).optional(),
  cloudProviderId: z.string().min(1).optional(),
});
export type CreateWorkloadRequest = z.infer<typeof CreateWorkloadRequest>;

export const PatchWorkloadRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    type: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    region: z.string().trim().max(40).optional(),
    status: z.enum(["ok", "warn", "danger"]).optional(),
    cpuPct: z.number().int().min(0).max(100).nullable().optional(),
    memPct: z.number().int().min(0).max(100).nullable().optional(),
    replicasReady: z.number().int().min(0).nullable().optional(),
    replicasDesired: z.number().int().min(0).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchWorkloadRequest = z.infer<typeof PatchWorkloadRequest>;

// ──────────────────────────────────────────────────────────────────
// Security scopes + bindings
// ──────────────────────────────────────────────────────────────────
export const SecurityScopeKindApi = z.enum([
  "security_group",
  "iam_role",
  "kms_key",
  "secret_store",
  "network_policy",
]);
export type SecurityScopeKindApi = z.infer<typeof SecurityScopeKindApi>;

export const SecurityScopeSummary = z.object({
  id: z.string(),
  cloudProviderId: z.string(),
  cloudProviderName: z.string(),
  kind: SecurityScopeKindApi,
  name: z.string(),
  ref: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type SecurityScopeSummary = z.infer<typeof SecurityScopeSummary>;

export const CreateScopeRequest = z.object({
  kind: SecurityScopeKindApi,
  name: z.string().trim().min(1).max(120),
  ref: z.string().trim().max(200).optional(),
});
export type CreateScopeRequest = z.infer<typeof CreateScopeRequest>;

export const BindScopeRequest = z.object({
  scopeId: z.string().min(1),
});
export type BindScopeRequest = z.infer<typeof BindScopeRequest>;

export const EnvBindingSummary = z.object({
  bindingId: z.string(),
  envKey: z.string(),
  scopeId: z.string(),
  scopeName: z.string(),
  scopeKind: SecurityScopeKindApi,
});
export type EnvBindingSummary = z.infer<typeof EnvBindingSummary>;
