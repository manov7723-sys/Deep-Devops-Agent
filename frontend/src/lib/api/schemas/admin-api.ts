import { z } from "zod";
import { PlanTierApi, SubscriptionStatusApi, InvoiceStatusApi } from "./billing-api";

// ──────────────────────────────────────────────────────────────────
// Admin KPIs (computed)
// ──────────────────────────────────────────────────────────────────
export const AdminKpis = z.object({
  totalUsers: z.number().int(),
  payingUsers: z.number().int(),
  trialUsers: z.number().int(),
  superAdmins: z.number().int(),
  totalProjects: z.number().int(),
  totalEnvs: z.number().int(),
  // Monthly Recurring Revenue (cents) — sum of base price across active subs
  mrrCents: z.number().int(),
  arrCents: z.number().int(),
  churnRate30d: z.number(), // 0..1
  newUsers7d: z.number().int(),
  newUsers30d: z.number().int(),
});
export type AdminKpis = z.infer<typeof AdminKpis>;

// ──────────────────────────────────────────────────────────────────
// Admin dashboard bundle — what `/admin/dashboard` returns.
//
// Server pre-formats `mrr`, `arr`, `churn` so the client renders them
// verbatim. Raw numbers stay on `AdminKpis` for any consumer that wants
// to format differently.
// ──────────────────────────────────────────────────────────────────
export const AdminDashboardKpisDisplay = z.object({
  mrr: z.string(), // "$48,920"
  arr: z.string(), // "$587k"
  users: z.number().int(),
  projects: z.number().int(),
  environments: z.number().int(),
  churn: z.string(), // "1.8%"
});
export type AdminDashboardKpisDisplay = z.infer<typeof AdminDashboardKpisDisplay>;

export const AdminPlanSlice = z.object({
  id: z.string(),
  name: z.string(),
  active: z.number().int(),
  accent: z.string(),
});
export type AdminPlanSlice = z.infer<typeof AdminPlanSlice>;

export const AdminMcpSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["ok", "warn", "down"]),
  callsPerDay: z.string(),
  latency: z.string(),
});
export type AdminMcpSummary = z.infer<typeof AdminMcpSummary>;

export const AdminRecentSignup = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  plan: z.enum(["Free", "Pro", "Scale", "Enterprise"]),
});
export type AdminRecentSignup = z.infer<typeof AdminRecentSignup>;

export const AdminDashboardPayload = z.object({
  kpis: AdminDashboardKpisDisplay,
  mrrTrend: z.array(z.number()),
  plans: z.array(AdminPlanSlice),
  paidUsers: z.number().int(),
  mcp: z.array(AdminMcpSummary),
  recentSignups: z.array(AdminRecentSignup),
});
export type AdminDashboardPayload = z.infer<typeof AdminDashboardPayload>;

// ──────────────────────────────────────────────────────────────────
// Admin users
// ──────────────────────────────────────────────────────────────────
export const AdminUserRow = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  isSuperAdmin: z.boolean(),
  twoFactorEnabled: z.boolean(),
  planTier: PlanTierApi.nullable(),
  subscriptionStatus: SubscriptionStatusApi.nullable(),
  ownedProjects: z.number().int(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type AdminUserRow = z.infer<typeof AdminUserRow>;

export const PatchAdminUserRequest = z
  .object({
    isSuperAdmin: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchAdminUserRequest = z.infer<typeof PatchAdminUserRequest>;

// ──────────────────────────────────────────────────────────────────
// Admin subscriptions
// ──────────────────────────────────────────────────────────────────
export const AdminSubscriptionRow = z.object({
  id: z.string(),
  userEmail: z.string().email(),
  userName: z.string(),
  planTier: PlanTierApi,
  planName: z.string(),
  status: SubscriptionStatusApi,
  basePriceCents: z.number().int(),
  currency: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.string().datetime().nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type AdminSubscriptionRow = z.infer<typeof AdminSubscriptionRow>;

// ──────────────────────────────────────────────────────────────────
// Admin billing
// ──────────────────────────────────────────────────────────────────
export const AdminInvoiceRow = z.object({
  id: z.string(),
  userEmail: z.string().email(),
  customerName: z.string().nullable(),
  number: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: InvoiceStatusApi,
  issuedAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
});
export type AdminInvoiceRow = z.infer<typeof AdminInvoiceRow>;

export const BillingStatsSummary = z.object({
  collectedCents: z.number().int(),
  outstandingCents: z.number().int(),
  failedCents: z.number().int(),
  refundedCents: z.number().int(),
  collectedCount: z.number().int(),
  outstandingCount: z.number().int(),
  failedCount: z.number().int(),
});
export type BillingStatsSummary = z.infer<typeof BillingStatsSummary>;

// ──────────────────────────────────────────────────────────────────
// Platform settings
// ──────────────────────────────────────────────────────────────────
export const PlatformSettingsSummary = z.object({
  siteTitle: z.string(),
  metaDescription: z.string(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int().nullable(),
  fromAddress: z.string().nullable(),
  smtpVerifiedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type PlatformSettingsSummary = z.infer<typeof PlatformSettingsSummary>;

export const PatchPlatformSettingsRequest = z
  .object({
    siteTitle: z.string().trim().min(1).max(120).optional(),
    metaDescription: z.string().trim().max(400).optional(),
    smtpHost: z.string().trim().max(120).nullable().optional(),
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    fromAddress: z.string().email().nullable().optional(),
    smtpVerifiedAt: z.string().datetime().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type PatchPlatformSettingsRequest = z.infer<typeof PatchPlatformSettingsRequest>;

export const PlatformAssetRow = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  url: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type PlatformAssetRow = z.infer<typeof PlatformAssetRow>;

export const UpsertAssetRequest = z.object({
  key: z.enum(["logo", "favicon", "og"]),
  label: z.string().trim().min(1).max(80).optional(),
  hint: z.string().trim().max(160).optional(),
  url: z.string().url().nullable().optional(),
});
export type UpsertAssetRequest = z.infer<typeof UpsertAssetRequest>;

export const PlatformEnvVarRow = z.object({
  key: z.string(),
  status: z.enum(["ok", "warn", "danger"]),
  statusLabel: z.string(),
  updatedAt: z.string().datetime(),
  hasValue: z.boolean(),
});
export type PlatformEnvVarRow = z.infer<typeof PlatformEnvVarRow>;

export const UpsertEnvVarRequest = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]*$/, "ENV_VAR_KEY format (uppercase, underscores)"),
  value: z.string().min(1),
  status: z.enum(["ok", "warn", "danger"]).default("ok"),
  statusLabel: z.string().trim().max(40).default("Set"),
});
export type UpsertEnvVarRequest = z.infer<typeof UpsertEnvVarRequest>;

export const SystemComponentRow = z.object({
  key: z.string(),
  name: z.string(),
  status: z.enum(["ok", "warn", "danger"]),
  note: z.string(),
});
export type SystemComponentRow = z.infer<typeof SystemComponentRow>;

export const UpsertSystemComponentRequest = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]*$/, "component_key format (lowercase)"),
  name: z.string().trim().min(1).max(80),
  status: z.enum(["ok", "warn", "danger"]).default("ok"),
  note: z.string().trim().max(280).default(""),
});
export type UpsertSystemComponentRequest = z.infer<typeof UpsertSystemComponentRequest>;
