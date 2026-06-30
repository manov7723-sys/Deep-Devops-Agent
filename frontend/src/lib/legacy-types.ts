/**
 * Legacy view-model shapes used by client components carried over from the
 * pre-Prisma mock phase. Everything in here is structural typing only — no
 * runtime data — and exists so app code no longer imports from `@/../seeds`
 * (which mixes types with seed-bootstrap *data* read by `prisma/seed.ts`).
 *
 * Long-term: each `Seed*` here should be replaced at its call site by the
 * matching schema in `@/lib/api/schemas/*`. Removing this file is a goal,
 * not a destination — incremental per-component renames are safe.
 */
export type {
  SeedAdminKpis,
  SeedAdminUser,
  SeedAdminPlan,
  SeedSubscriptionAddon,
  SeedAdminSubscription,
  SeedMcpConnector,
  AdminPlanTier,
  AdminUserStatus,
  SubscriptionStatus,
} from "../../seeds/admin-data";

export type {
  SeedAdminAddonPurchase,
  SeedAdminInvoice,
  SeedAgent,
  SeedAdminModel,
  SeedEnvVar,
  SeedSystemComponent,
  SeedPlatformSettings,
  BillingStats,
} from "../../seeds/admin-ops-data";

export type { SeedUsage, SeedPlan, SeedAddon } from "../../seeds/billing";

export type {
  SeedCloudProvider,
  SeedCloudResource,
  SeedObservabilityKpi,
  SeedTask,
  CloudCategory,
} from "../../seeds/cloud-data";

export type {
  SeedKnowledgeDoc,
  SeedAlert,
  SeedApprovalDetail,
  SeedIntegration,
  AlertCategory,
} from "../../seeds/project-content";

export type {
  SeedEnv,
  SeedWorkload,
  SeedPipeline,
  SeedApproval,
  SeedActivity,
  SeedCostByEnv,
  SeedProjectRepo,
  SeedIssue,
  SeedChatSuggestion,
  SeedChatPlanStep,
  SeedChatMessage,
  EnvId,
} from "../../seeds/project-data";

export type { SeedProject } from "../../seeds/projects";
export type { SeedRepo } from "../../seeds/repos";
export type { SeedTeamMember } from "../../seeds/teams";

// Data constants whose shapes are used with `typeof` for type derivation
// (cost panels, observability dashboards). costExtendedSeed lives in
// cloud-data.ts despite the project-cost feel.
export { costSeed } from "../../seeds/project-data";
export { costExtendedSeed, prometheusSeed, grafanaSeed } from "../../seeds/cloud-data";
