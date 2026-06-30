import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Plans
// ──────────────────────────────────────────────────────────────────
export const PlanTierApi = z.enum(["Free", "Pro", "Scale", "Enterprise"]);
export type PlanTierApi = z.infer<typeof PlanTierApi>;

export const BillingPeriodApi = z.enum(["month", "year", "forever", "none"]);

export const PlanSummary = z.object({
  id: z.string(),
  tier: PlanTierApi,
  name: z.string(),
  priceCents: z.number().int().nullable(),
  isCustomPrice: z.boolean(),
  currency: z.string(),
  period: BillingPeriodApi,
  popular: z.boolean(),
  sortOrder: z.number().int(),
  projectLimit: z.number().int().nullable(),
  envLimit: z.number().int().nullable(),
  seatLimit: z.number().int().nullable(),
  agentTier: z.string().nullable(),
  highlights: z.array(z.string()),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const CreatePlanRequest = z.object({
  tier: PlanTierApi,
  name: z.string().trim().min(1).max(80),
  priceCents: z.number().int().min(0).nullable().optional(),
  isCustomPrice: z.boolean().default(false),
  currency: z.string().trim().length(3).default("usd"),
  period: BillingPeriodApi.default("month"),
  popular: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
  stripeProductId: z.string().optional(),
  stripePriceId: z.string().optional(),
  projectLimit: z.number().int().min(0).nullable().optional(),
  envLimit: z.number().int().min(0).nullable().optional(),
  seatLimit: z.number().int().min(0).nullable().optional(),
  agentTier: z.string().trim().max(60).optional(),
  highlights: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

// ──────────────────────────────────────────────────────────────────
// Addons
// ──────────────────────────────────────────────────────────────────
export const AddonSummary = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  priceCents: z.number().int(),
  currency: z.string(),
  active: z.boolean(),
});
export type AddonSummary = z.infer<typeof AddonSummary>;

export const CreateAddonRequest = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(280),
  priceCents: z.number().int().min(0),
  currency: z.string().trim().length(3).default("usd"),
  tokenGrant: z.number().int().min(0).default(0),
  stripeProductId: z.string().optional(),
  stripePriceId: z.string().optional(),
});
export type CreateAddonRequest = z.infer<typeof CreateAddonRequest>;

// ──────────────────────────────────────────────────────────────────
// Subscription / payment method / invoice / usage (read-only mirrors)
// ──────────────────────────────────────────────────────────────────
export const SubscriptionStatusApi = z.enum([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

export const SubscriptionSummary = z.object({
  id: z.string(),
  planTier: PlanTierApi,
  planName: z.string(),
  status: SubscriptionStatusApi,
  basePriceCents: z.number().int(),
  currency: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodStart: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  canceledAt: z.string().datetime().nullable(),
  renewsLabel: z.string().nullable(),
});
export type SubscriptionSummary = z.infer<typeof SubscriptionSummary>;

export const PaymentMethodSummary = z.object({
  id: z.string(),
  brand: z.enum(["visa", "mastercard", "amex", "discover", "diners", "jcb", "unionpay", "unknown"]),
  last4: z.string(),
  expMonth: z.number().int(),
  expYear: z.number().int(),
  isDefault: z.boolean(),
  createdAt: z.string().datetime(),
});
export type PaymentMethodSummary = z.infer<typeof PaymentMethodSummary>;

export const InvoiceStatusApi = z.enum(["draft", "open", "paid", "void", "uncollectible"]);

export const InvoiceSummary = z.object({
  id: z.string(),
  number: z.string().nullable(),
  amountCents: z.number().int(),
  currency: z.string(),
  status: InvoiceStatusApi,
  hostedInvoiceUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  issuedAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
});
export type InvoiceSummary = z.infer<typeof InvoiceSummary>;

export const UsageSummary = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  agentRunsUsed: z.number().int(),
  agentRunsLimit: z.number().int().nullable(),
  deploysUsed: z.number().int(),
  deploysLimit: z.number().int().nullable(),
  seatsUsed: z.number().int(),
  seatsLimit: z.number().int().nullable(),
  envsUsed: z.number().int(),
  envsLimit: z.number().int().nullable(),
  tokensUsed: z.number().int(),
  samples: z.array(
    z.object({ weekStart: z.string().datetime(), tokens: z.number().int() }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const MyAddonSummary = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  priceCents: z.number().int(),
  status: z.enum(["active", "cancelled", "pending"]),
  purchasedAt: z.string().datetime(),
});
export type MyAddonSummary = z.infer<typeof MyAddonSummary>;

// ──────────────────────────────────────────────────────────────────
// Stripe flow requests
// ──────────────────────────────────────────────────────────────────
export const CheckoutRequest = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("new_subscription"),
    planId: z.string().min(1),
  }),
  z.object({
    purpose: z.literal("add_addon"),
    addonId: z.string().min(1),
  }),
  z.object({
    purpose: z.literal("update_payment_method"),
  }),
]);
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;
