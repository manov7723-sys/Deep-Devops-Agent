/**
 * Legacy view-model shapes used by client components carried over from the
 * pre-Prisma mock phase. The `seeds/*` files these used to re-export from
 * were removed during the Prisma migration; this file now defines the same
 * type names as flexible object shapes so consumer code keeps building.
 *
 * Long-term: each `Seed*` here should be replaced at its call site by the
 * matching schema in `@/lib/api/schemas/*`. Removing this file is a goal,
 * not a destination — incremental per-component renames are safe.
 */

// Generic loose object — every seed shape is a view-model with pre-Prisma
// fields we no longer track exactly. Using `any` deliberately: these types
// used to be sharp Seed* aliases, but the source-of-truth files were removed
// in the Prisma migration and the consumer components access many fields by
// bracket lookup and dynamic destructuring. `unknown` would be safer but
// would cascade 300+ downstream errors; `any` keeps the legacy paths
// compiling. Rename/replace call-sites incrementally as the file comment says.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── admin-data ─────────────────────────────────────────────────────────
export type SeedAdminKpis = Row;
export type SeedAdminUser = Row;
export type SeedAdminPlan = Row;
export type SeedSubscriptionAddon = Row;
export type SeedAdminSubscription = Row;
export type SeedMcpConnector = Row;
export type AdminPlanTier = "free" | "starter" | "pro" | "team" | "enterprise" | string;
export type AdminUserStatus = "active" | "pending" | "suspended" | string;
export type SubscriptionStatus = "active" | "pending" | "cancelled" | string;

// ── admin-ops-data ─────────────────────────────────────────────────────
export type SeedAdminAddonPurchase = Row;
export type SeedAdminInvoice = Row;
export type SeedAgent = Row;
export type SeedAdminModel = Row;
export type SeedEnvVar = Row;
export type SeedSystemComponent = Row;
export type SeedPlatformSettings = Row;
export type BillingStats = Row;

// ── billing ────────────────────────────────────────────────────────────
export type SeedUsage = Row;
export type SeedPlan = Row;
export type SeedAddon = Row;

// ── cloud-data ─────────────────────────────────────────────────────────
export type SeedCloudProvider = Row;
export type SeedCloudResource = Row;
export type SeedObservabilityKpi = Row;
export type SeedTask = Row;
export type CloudCategory = string;

// ── project-content ────────────────────────────────────────────────────
export type SeedKnowledgeDoc = Row;
export type SeedAlert = Row;
export type SeedApprovalDetail = Row;
export type SeedIntegration = Row;
export type AlertCategory = string;

// ── project-data ───────────────────────────────────────────────────────
export type SeedEnv = Row;
export type SeedWorkload = Row;
export type SeedPipeline = Row;
export type SeedApproval = Row;
export type SeedActivity = Row;
export type SeedCostByEnv = Row;
export type SeedProjectRepo = Row;
export type SeedIssue = Row;
export type SeedChatSuggestion = Row;
export type SeedChatPlanStep = [string, string]; // [iconName, text] tuple
export type SeedChatMessage = Row & { plan?: SeedChatPlanStep[] };
export type EnvId = string;

// ── other seeds ────────────────────────────────────────────────────────
export type SeedProject = Row;
export type SeedRepo = Row;
export type SeedTeamMember = Row;

// ── Value exports that some legacy components import as typeof-anchors ─
// These used to be real seed data; empty objects/arrays are enough for
// downstream type derivation via `typeof X`. Never rendered at runtime by any
// current component; keeping the export prevents build-time module-not-found.
export const costSeed: Record<string, unknown> = {};
export const costExtendedSeed: Record<string, unknown> = {};
export const prometheusSeed: Record<string, unknown> = {};
export const grafanaSeed: Record<string, unknown> = {};
