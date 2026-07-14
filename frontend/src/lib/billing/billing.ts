/**
 * Billing read surface + webhook dispatch helpers.
 *
 * Stripe is the source of truth. Local rows (Subscription, Invoice,
 * PaymentMethod, SubscriptionAddon) are display-only mirrors kept in sync via
 * the webhook handler. The `me/*` endpoints read from these rows.
 *
 * The webhook dispatch helpers below are idempotent — re-running the same
 * event payload produces the same row state (used by replay-safety logic).
 */
import type {
  AddonStatus,
  CardBrand,
  InvoiceStatus,
  Plan,
  PlanTier,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

// ──────────────────────────────────────────────────────────────────
// Catalog reads
// ──────────────────────────────────────────────────────────────────

export type PlanRow = {
  id: string;
  tier: PlanTier;
  name: string;
  priceCents: number | null;
  isCustomPrice: boolean;
  currency: string;
  period: "month" | "year" | "forever" | "none";
  popular: boolean;
  sortOrder: number;
  projectLimit: number | null;
  envLimit: number | null;
  seatLimit: number | null;
  agentTier: string | null;
  highlights: string[];
};

function planRow(p: Plan): PlanRow {
  return {
    id: p.id,
    tier: p.tier,
    name: p.name,
    priceCents: p.priceCents,
    isCustomPrice: p.isCustomPrice,
    currency: p.currency,
    period: p.period,
    popular: p.popular,
    sortOrder: p.sortOrder,
    projectLimit: p.projectLimit,
    envLimit: p.envLimit,
    seatLimit: p.seatLimit,
    agentTier: p.agentTier,
    highlights: p.highlights,
  };
}

export async function listPlans(): Promise<PlanRow[]> {
  const rows = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
  return rows.map(planRow);
}

export async function listAddons(): Promise<
  Array<{
    id: string;
    name: string;
    icon: string;
    description: string;
    priceCents: number;
    currency: string;
    tokenGrant: number;
    active: boolean;
  }>
> {
  const rows = await prisma.addon.findMany({
    where: { active: true },
    orderBy: { priceCents: "asc" },
  });
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    description: a.description,
    priceCents: a.priceCents,
    currency: a.currency,
    tokenGrant: a.tokenGrant,
    active: a.active,
  }));
}

// ──────────────────────────────────────────────────────────────────
// Catalog writes (admin)
// ──────────────────────────────────────────────────────────────────

export type CreatePlanArgs = {
  tier: PlanTier;
  name: string;
  priceCents?: number | null;
  isCustomPrice: boolean;
  currency: string;
  period: "month" | "year" | "forever" | "none";
  popular: boolean;
  sortOrder: number;
  stripeProductId?: string;
  stripePriceId?: string;
  projectLimit?: number | null;
  envLimit?: number | null;
  seatLimit?: number | null;
  agentTier?: string;
  highlights: string[];
};

export type CreatePlanResult = { ok: true; plan: PlanRow } | { ok: false; code: "duplicate_tier" };

export async function createPlan(args: CreatePlanArgs): Promise<CreatePlanResult> {
  try {
    const created = await prisma.plan.create({
      data: {
        tier: args.tier,
        name: args.name,
        priceCents: args.priceCents ?? null,
        isCustomPrice: args.isCustomPrice,
        currency: args.currency,
        period: args.period,
        popular: args.popular,
        sortOrder: args.sortOrder,
        stripeProductId: args.stripeProductId ?? null,
        stripePriceId: args.stripePriceId ?? null,
        projectLimit: args.projectLimit ?? null,
        envLimit: args.envLimit ?? null,
        seatLimit: args.seatLimit ?? null,
        agentTier: args.agentTier ?? null,
        highlights: args.highlights,
      },
    });
    return { ok: true, plan: planRow(created) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { ok: false, code: "duplicate_tier" };
    }
    throw err;
  }
}

export type CreateAddonArgs = {
  name: string;
  icon: string;
  description: string;
  priceCents: number;
  currency: string;
  tokenGrant?: number;
  stripeProductId?: string;
  stripePriceId?: string;
};

export async function createAddon(args: CreateAddonArgs): Promise<{
  id: string;
  name: string;
  icon: string;
  description: string;
  priceCents: number;
  currency: string;
  tokenGrant: number;
  active: boolean;
}> {
  const created = await prisma.addon.create({
    data: {
      name: args.name,
      icon: args.icon,
      description: args.description,
      priceCents: args.priceCents,
      currency: args.currency,
      tokenGrant: args.tokenGrant ?? 0,
      stripeProductId: args.stripeProductId ?? null,
      stripePriceId: args.stripePriceId ?? null,
    },
  });
  return {
    id: created.id,
    name: created.name,
    icon: created.icon,
    description: created.description,
    priceCents: created.priceCents,
    currency: created.currency,
    tokenGrant: created.tokenGrant,
    active: created.active,
  };
}

// ──────────────────────────────────────────────────────────────────
// Me reads
// ──────────────────────────────────────────────────────────────────

export type SubscriptionRow = {
  id: string;
  planTier: PlanTier;
  planName: string;
  status: SubscriptionStatus;
  basePriceCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  canceledAt: string | null;
  renewsLabel: string | null;
};

export async function getMySubscription(userId: string): Promise<SubscriptionRow | null> {
  const s = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: { select: { name: true, tier: true } } },
  });
  if (!s) return null;
  return {
    id: s.id,
    planTier: s.plan.tier,
    planName: s.plan.name,
    status: s.status,
    basePriceCents: s.basePriceCents,
    currency: s.currency,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
    canceledAt: s.canceledAt?.toISOString() ?? null,
    renewsLabel: s.renewsLabel,
  };
}

export async function listMyPaymentMethods(userId: string): Promise<
  Array<{
    id: string;
    brand: CardBrand;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
    createdAt: string;
  }>
> {
  const rows = await prisma.paymentMethod.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((p) => ({
    id: p.id,
    brand: p.brand,
    last4: p.last4,
    expMonth: p.expMonth,
    expYear: p.expYear,
    isDefault: p.isDefault,
    createdAt: p.createdAt.toISOString(),
  }));
}

export async function listMyInvoices(userId: string): Promise<
  Array<{
    id: string;
    number: string | null;
    amountCents: number;
    currency: string;
    status: InvoiceStatus;
    hostedInvoiceUrl: string | null;
    pdfUrl: string | null;
    issuedAt: string;
    paidAt: string | null;
  }>
> {
  const rows = await prisma.invoice.findMany({
    where: { userId },
    orderBy: { issuedAt: "desc" },
  });
  return rows.map((i) => ({
    id: i.id,
    number: i.number,
    amountCents: i.amountCents,
    currency: i.currency,
    status: i.status,
    hostedInvoiceUrl: i.hostedInvoiceUrl,
    pdfUrl: i.pdfUrl,
    issuedAt: i.issuedAt.toISOString(),
    paidAt: i.paidAt?.toISOString() ?? null,
  }));
}

export type MyUsageShape = {
  periodStart: string;
  periodEnd: string;
  agentRunsUsed: number;
  agentRunsLimit: number | null;
  deploysUsed: number;
  deploysLimit: number | null;
  seatsUsed: number;
  seatsLimit: number | null;
  envsUsed: number;
  envsLimit: number | null;
  tokensUsed: number;
  tokensGranted: number;
  tokensRemaining: number;
  /**
   * True when the caller has effectively-unlimited token access. Today this
   * is the case for super-admins (User.isSuperAdmin). UI should render
   * "Unlimited" instead of any numeric balance when this is set, and skip
   * any low-balance warning.
   */
  unlimited: boolean;
  samples: Array<{ weekStart: string; tokens: number }>;
};

/**
 * Always returns a usable shape — when the user has no Usage row yet
 * (never bought a token pack, never ran an agent) we synthesize a
 * zero-state object scoped to the current calendar month. The UI uses
 * this for the "tokens left" badge so the page never shows "—".
 *
 * Super-admins are billed as unlimited: token deductions don't apply and
 * the page hides the "buy more tokens" CTA. We still expose the raw
 * granted/used numbers so the admin can see what's been spent on their
 * (notional) usage records.
 */
export async function getMyUsage(userId: string): Promise<MyUsageShape> {
  const [u, user, samples] = await Promise.all([
    prisma.usage.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } }),
    prisma.usageSample.findMany({
      where: { userId },
      orderBy: { weekStart: "asc" },
      take: 26,
    }),
  ]);
  const unlimited = !!user?.isSuperAdmin;

  if (!u) {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      agentRunsUsed: 0,
      agentRunsLimit: null,
      deploysUsed: 0,
      deploysLimit: null,
      seatsUsed: 0,
      seatsLimit: null,
      envsUsed: 0,
      envsLimit: null,
      tokensUsed: 0,
      tokensGranted: 0,
      tokensRemaining: 0,
      unlimited,
      samples: samples.map((s) => ({ weekStart: s.weekStart.toISOString(), tokens: s.tokens })),
    };
  }

  // Remaining = granted - used (clamped to 0). Plan-baseline tokens, if you
  // model them, would be added here as well; today the plan tier doesn't ship
  // tokens inline — every token comes from a Token pack purchase.
  const granted = Number(u.tokensGranted);
  const used = Number(u.tokensUsed);
  const remaining = Math.max(0, granted - used);
  return {
    periodStart: u.periodStart.toISOString(),
    periodEnd: u.periodEnd.toISOString(),
    agentRunsUsed: u.agentRunsUsed,
    agentRunsLimit: u.agentRunsLimit,
    deploysUsed: u.deploysUsed,
    deploysLimit: u.deploysLimit,
    seatsUsed: u.seatsUsed,
    seatsLimit: u.seatsLimit,
    envsUsed: u.envsUsed,
    envsLimit: u.envsLimit,
    tokensUsed: used,
    tokensGranted: granted,
    tokensRemaining: remaining,
    unlimited,
    samples: samples.map((s) => ({ weekStart: s.weekStart.toISOString(), tokens: s.tokens })),
  };
}

export async function listMyAddons(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    icon: string;
    priceCents: number;
    status: AddonStatus;
    purchasedAt: string;
  }>
> {
  const rows = await prisma.subscriptionAddon.findMany({
    where: { subscription: { userId } },
    orderBy: { purchasedAt: "desc" },
  });
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    priceCents: a.priceCents,
    status: a.status,
    purchasedAt: a.purchasedAt.toISOString(),
  }));
}

// ──────────────────────────────────────────────────────────────────
// Webhook dispatch helpers — idempotent upserts
// ──────────────────────────────────────────────────────────────────

export async function recordStripeEvent(args: {
  id: string;
  type: string;
  apiVersion?: string;
  payload: unknown;
}): Promise<{ duplicate: boolean }> {
  // Insert first, succeed-or-skip via the unique PK.
  try {
    await prisma.stripeEvent.create({
      data: {
        id: args.id,
        type: args.type,
        apiVersion: args.apiVersion ?? null,
        payload: (args.payload as object) ?? null,
        receivedAt: new Date(),
      },
    });
    return { duplicate: false };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return { duplicate: true };
    }
    throw err;
  }
}

export async function markStripeEventProcessed(eventId: string, error?: string): Promise<void> {
  await prisma.stripeEvent.update({
    where: { id: eventId },
    data: { processedAt: new Date(), error: error ?? null },
  });
}

export type UpsertSubscriptionArgs = {
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId?: string;
  status: SubscriptionStatus;
  basePriceCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  canceledAt?: Date;
  planId: string;
};

export async function upsertSubscription(args: UpsertSubscriptionArgs): Promise<void> {
  await prisma.subscription.upsert({
    where: { userId: args.userId },
    create: {
      userId: args.userId,
      planId: args.planId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId ?? null,
      status: args.status,
      basePriceCents: args.basePriceCents,
      currency: args.currency,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      currentPeriodStart: args.currentPeriodStart ?? null,
      currentPeriodEnd: args.currentPeriodEnd ?? null,
      trialEndsAt: args.trialEndsAt ?? null,
      canceledAt: args.canceledAt ?? null,
    },
    update: {
      planId: args.planId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId ?? null,
      status: args.status,
      basePriceCents: args.basePriceCents,
      currency: args.currency,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      currentPeriodStart: args.currentPeriodStart ?? null,
      currentPeriodEnd: args.currentPeriodEnd ?? null,
      trialEndsAt: args.trialEndsAt ?? null,
      canceledAt: args.canceledAt ?? null,
    },
  });
}

export type UpsertInvoiceArgs = {
  userId: string;
  stripeInvoiceId: string;
  number?: string;
  customerName?: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  hostedInvoiceUrl?: string;
  pdfUrl?: string;
  issuedAt: Date;
  paidAt?: Date;
};

export async function upsertInvoice(args: UpsertInvoiceArgs): Promise<void> {
  await prisma.invoice.upsert({
    where: { stripeInvoiceId: args.stripeInvoiceId },
    create: {
      userId: args.userId,
      stripeInvoiceId: args.stripeInvoiceId,
      number: args.number ?? null,
      customerName: args.customerName ?? null,
      amountCents: args.amountCents,
      currency: args.currency,
      status: args.status,
      hostedInvoiceUrl: args.hostedInvoiceUrl ?? null,
      pdfUrl: args.pdfUrl ?? null,
      issuedAt: args.issuedAt,
      paidAt: args.paidAt ?? null,
    },
    update: {
      number: args.number ?? null,
      customerName: args.customerName ?? null,
      amountCents: args.amountCents,
      currency: args.currency,
      status: args.status,
      hostedInvoiceUrl: args.hostedInvoiceUrl ?? null,
      pdfUrl: args.pdfUrl ?? null,
      paidAt: args.paidAt ?? null,
    },
  });
}

export type UpsertPaymentMethodArgs = {
  userId: string;
  stripePaymentMethodId: string;
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

export async function upsertPaymentMethod(args: UpsertPaymentMethodArgs): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (args.isDefault) {
      await tx.paymentMethod.updateMany({
        where: { userId: args.userId, isDefault: true },
        data: { isDefault: false },
      });
    }
    await tx.paymentMethod.upsert({
      where: { stripePaymentMethodId: args.stripePaymentMethodId },
      create: {
        userId: args.userId,
        stripePaymentMethodId: args.stripePaymentMethodId,
        brand: args.brand,
        last4: args.last4,
        expMonth: args.expMonth,
        expYear: args.expYear,
        isDefault: args.isDefault,
      },
      update: {
        brand: args.brand,
        last4: args.last4,
        expMonth: args.expMonth,
        expYear: args.expYear,
        isDefault: args.isDefault,
      },
    });
  });
}

export async function findUserByStripeCustomerId(stripeCustomerId: string): Promise<{
  id: string;
  email: string;
} | null> {
  const u = await prisma.user.findUnique({
    where: { stripeCustomerId },
    select: { id: true, email: true },
  });
  return u;
}

export async function attachStripeCustomerId(userId: string, customerId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customerId },
  });
}

export async function findPlanByStripePriceId(priceId: string): Promise<Plan | null> {
  return prisma.plan.findFirst({ where: { stripePriceId: priceId } });
}

export async function recordCheckoutSession(args: {
  id: string;
  userId: string;
  mode: "subscription" | "setup" | "payment";
  purpose: string;
}): Promise<void> {
  await prisma.checkoutSession.create({
    data: {
      id: args.id,
      userId: args.userId,
      mode: args.mode,
      purpose: args.purpose,
    },
  });
}
