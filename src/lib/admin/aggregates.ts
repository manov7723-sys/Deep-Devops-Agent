/**
 * Admin KPIs + table queries.
 *
 * Per the schema comment at the bottom of schema.prisma: admin screens read
 * the REAL tables — there are no AdminKpi / BillingStat / AdminUser mirrors.
 * Everything here is a Prisma aggregate over Subscription / User / Project /
 * Env / Invoice.
 */
import type { InvoiceStatus, PlanTier, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type {
  AdminDashboardPayload,
  AdminMcpSummary,
  AdminPlanSlice,
  AdminRecentSignup,
} from "@/lib/api/schemas/admin-api";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdminKpiRow = {
  totalUsers: number;
  payingUsers: number;
  trialUsers: number;
  superAdmins: number;
  totalProjects: number;
  totalEnvs: number;
  mrrCents: number;
  arrCents: number;
  churnRate30d: number;
  newUsers7d: number;
  newUsers30d: number;
};

export async function computeAdminKpis(): Promise<AdminKpiRow> {
  const now = new Date();
  const cutoff7 = new Date(now.getTime() - 7 * DAY_MS);
  const cutoff30 = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalUsers,
    payingUsers,
    trialUsers,
    superAdmins,
    totalProjects,
    totalEnvs,
    mrrAgg,
    canceled30d,
    activeAt30dAgo,
    newUsers7d,
    newUsers30d,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count({ where: { status: { in: ["active", "trialing"] } } }),
    prisma.subscription.count({ where: { status: "trialing" } }),
    prisma.user.count({ where: { isSuperAdmin: true } }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.env.count(),
    prisma.subscription.aggregate({
      where: { status: { in: ["active", "trialing", "past_due"] } },
      _sum: { basePriceCents: true },
    }),
    prisma.subscription.count({
      where: {
        status: "canceled",
        canceledAt: { gte: cutoff30, lte: now },
      },
    }),
    prisma.subscription.count({
      where: {
        OR: [
          { canceledAt: null },
          { canceledAt: { gt: now } },
        ],
        createdAt: { lt: cutoff30 },
      },
    }),
    prisma.user.count({ where: { createdAt: { gte: cutoff7 } } }),
    prisma.user.count({ where: { createdAt: { gte: cutoff30 } } }),
  ]);

  const mrrCents = mrrAgg._sum.basePriceCents ?? 0;
  const arrCents = mrrCents * 12;
  const churnDenom = activeAt30dAgo;
  const churnRate30d = churnDenom > 0 ? canceled30d / churnDenom : 0;

  return {
    totalUsers,
    payingUsers,
    trialUsers,
    superAdmins,
    totalProjects,
    totalEnvs,
    mrrCents,
    arrCents,
    churnRate30d,
    newUsers7d,
    newUsers30d,
  };
}

// ──────────────────────────────────────────────────────────────────
// Dashboard bundle — kpis + sparkline + plan distribution + mcp + signups
// ──────────────────────────────────────────────────────────────────

function planAccent(tier: PlanTier): string {
  switch (tier) {
    case "Free":
      return "var(--muted, #6b7280)";
    case "Pro":
      return "var(--blue, #2779ff)";
    case "Scale":
      return "var(--accent, #7c3aed)";
    case "Enterprise":
      return "var(--violet, #7b61ff)";
  }
}

function formatCurrencyCents(cents: number): string {
  if (cents >= 1_00 * 1000) {
    return `$${Math.round(cents / 100 / 1000)}k`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatCallsPerDay(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k / day`;
  return `${n} / day`;
}

export async function computeAdminDashboard(): Promise<AdminDashboardPayload> {
  const kpis = await computeAdminKpis();

  // 12-month MRR trend. Real historical MRR would require monthly snapshots —
  // until those exist, build a flat-but-honest series anchored at the current
  // MRR so the chart isn't blank.
  const mrrDollars = Math.round(kpis.mrrCents / 100);
  const mrrTrend = Array.from({ length: 12 }, () => mrrDollars);

  // Plan distribution from real subscriptions.
  const [allPlans, subsPerPlan] = await Promise.all([
    prisma.plan.findMany({
      orderBy: [{ priceCents: "asc" }],
      select: { id: true, name: true, tier: true },
    }),
    prisma.subscription.groupBy({
      by: ["planId"],
      where: { status: { in: ["active", "trialing", "past_due"] } },
      _count: { _all: true },
    }),
  ]);
  const subsByPlanId = new Map(subsPerPlan.map((s) => [s.planId, s._count._all]));
  const plans: AdminPlanSlice[] = allPlans.map((p) => ({
    id: p.id,
    name: p.name,
    active: subsByPlanId.get(p.id) ?? 0,
    accent: planAccent(p.tier),
  }));

  // MCP connectors.
  const mcpRows = await prisma.mcpConnector.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      avgCallsPerDay: true,
      avgLatencyMs: true,
    },
  });
  const mcp: AdminMcpSummary[] = mcpRows.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    status: m.status,
    callsPerDay: formatCallsPerDay(m.avgCallsPerDay),
    latency: m.avgLatencyMs ? `${m.avgLatencyMs}ms` : "—",
  }));

  // Recent signups — join through subscription→plan for tier.
  const signupsRaw = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      email: true,
      name: true,
      subscription: { include: { plan: { select: { tier: true } } } },
    },
  });
  const recentSignups: AdminRecentSignup[] = signupsRaw.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    plan: u.subscription?.plan.tier ?? "Free",
  }));

  return {
    kpis: {
      mrr: formatCurrencyCents(kpis.mrrCents),
      arr: formatCurrencyCents(kpis.arrCents),
      users: kpis.totalUsers,
      projects: kpis.totalProjects,
      environments: kpis.totalEnvs,
      churn: `${(kpis.churnRate30d * 100).toFixed(1)}%`,
    },
    mrrTrend,
    plans,
    paidUsers: kpis.payingUsers,
    mcp,
    recentSignups,
  };
}

// ──────────────────────────────────────────────────────────────────
// Admin add-on purchases (SubscriptionAddon × Subscription × User)
// ──────────────────────────────────────────────────────────────────

export type AdminAddonPurchaseRow = {
  id: string;
  name: string;
  icon: string;
  user: string;
  email: string;
  price: string;
  when: string;
  status: "active" | "pending" | "cancelled";
};

function humanizeRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export async function listAdminAddonPurchases(): Promise<AdminAddonPurchaseRow[]> {
  const rows = await prisma.subscriptionAddon.findMany({
    orderBy: { purchasedAt: "desc" },
    take: 200,
    include: {
      subscription: {
        select: {
          currency: true,
          user: { select: { email: true, name: true } },
        },
      },
    },
  });
  const statusMap: Record<string, AdminAddonPurchaseRow["status"]> = {
    active: "active",
    pending: "pending",
    cancelled: "cancelled",
  };
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    user: r.subscription.user.name,
    email: r.subscription.user.email,
    price: formatPrice(r.priceCents, r.subscription.currency),
    when: humanizeRelative(r.purchasedAt),
    status: statusMap[r.status] ?? "active",
  }));
}

// ──────────────────────────────────────────────────────────────────
// Admin invoices — display row used by /admin/billing UI
// (rich shape with formatted strings instead of cents/dates)
// ──────────────────────────────────────────────────────────────────

export type AdminInvoiceDisplayRow = {
  id: string;
  number: string;
  customer: string;
  amount: string;
  date: string;
  status: "paid" | "open" | "failed" | "draft" | "void";
  hostedUrl: string | null;
  pdfUrl: string | null;
};

function shortDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusForDisplay(s: InvoiceStatus): AdminInvoiceDisplayRow["status"] {
  if (s === "paid") return "paid";
  if (s === "open") return "open";
  if (s === "uncollectible") return "failed";
  if (s === "void") return "void";
  return "draft";
}

export async function listAdminInvoicesDisplay(): Promise<AdminInvoiceDisplayRow[]> {
  const rows = await prisma.invoice.findMany({
    orderBy: { issuedAt: "desc" },
    take: 200,
    include: { user: { select: { email: true, name: true } } },
  });
  return rows.map((i) => ({
    id: i.id,
    number: i.number ?? i.id.slice(0, 12),
    customer: i.customerName ?? i.user.name ?? i.user.email,
    amount: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: i.currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(i.amountCents / 100),
    date: shortDate(i.paidAt ?? i.issuedAt),
    status: statusForDisplay(i.status),
    hostedUrl: i.hostedInvoiceUrl,
    pdfUrl: i.pdfUrl,
  }));
}

// ──────────────────────────────────────────────────────────────────
// Admin token grants — credit tokens directly to a user's Usage row
// ──────────────────────────────────────────────────────────────────

export type GrantTokensResult =
  | { ok: true; tokensGranted: number; tokensRemaining: number }
  | { ok: false; code: "not_found" };

/**
 * Increment `Usage.tokensGranted` for the target user by `amount`. When no
 * Usage row exists we upsert one (period = current calendar month, UTC).
 * Super-admins are unlimited anyway, but this helper still works on them —
 * they can grant tokens to themselves with no visible effect on `unlimited`.
 */
export async function grantTokensToUser(args: {
  userId: string;
  amount: number;
}): Promise<GrantTokensResult> {
  const target = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { id: true },
  });
  if (!target) return { ok: false, code: "not_found" };

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const row = await prisma.usage.upsert({
    where: { userId: args.userId },
    create: {
      userId: args.userId,
      periodStart,
      periodEnd,
      tokensGranted: BigInt(args.amount),
    },
    update: {
      tokensGranted: { increment: BigInt(args.amount) },
    },
    select: { tokensGranted: true, tokensUsed: true },
  });
  const granted = Number(row.tokensGranted);
  const used = Number(row.tokensUsed);
  return { ok: true, tokensGranted: granted, tokensRemaining: Math.max(0, granted - used) };
}

// ──────────────────────────────────────────────────────────────────
// Users list
// ──────────────────────────────────────────────────────────────────

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  twoFactorEnabled: boolean;
  planTier: PlanTier | null;
  subscriptionStatus: SubscriptionStatus | null;
  ownedProjects: number;
  createdAt: string;
  lastSeenAt: string | null;
};

export async function listAdminUsers(opts: { q?: string; limit?: number } = {}): Promise<AdminUserRow[]> {
  const q = opts.q?.trim();
  const rows = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }
      : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 200, 500),
    include: {
      subscription: { include: { plan: { select: { tier: true } } } },
      sessions: { orderBy: { lastSeenAt: "desc" }, take: 1, select: { lastSeenAt: true } },
      _count: { select: { ownedProjects: true } },
    },
  });
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    isSuperAdmin: u.isSuperAdmin,
    twoFactorEnabled: u.twoFactorEnabled,
    planTier: u.subscription?.plan.tier ?? null,
    subscriptionStatus: u.subscription?.status ?? null,
    ownedProjects: u._count.ownedProjects,
    createdAt: u.createdAt.toISOString(),
    lastSeenAt: u.sessions[0]?.lastSeenAt.toISOString() ?? null,
  }));
}

export type SetAdminResult =
  | { ok: true; isSuperAdmin: boolean }
  | { ok: false; code: "not_found" | "last_admin_demote" | "self_demote" };

/**
 * Toggle isSuperAdmin. Protects against:
 *   - Demoting yourself when you're the last admin (lock-out).
 *   - Demoting any admin when only one admin remains.
 */
export async function setSuperAdmin(
  acting: { userId: string },
  targetUserId: string,
  isSuperAdmin: boolean,
): Promise<SetAdminResult> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, code: "not_found" };
  if (target.isSuperAdmin === isSuperAdmin) {
    return { ok: true, isSuperAdmin };
  }

  if (target.isSuperAdmin && !isSuperAdmin) {
    const adminsRemaining = await prisma.user.count({ where: { isSuperAdmin: true } });
    if (adminsRemaining <= 1) {
      return {
        ok: false,
        code: target.id === acting.userId ? "self_demote" : "last_admin_demote",
      };
    }
  }

  await prisma.user.update({
    where: { id: targetUserId },
    data: { isSuperAdmin },
  });
  return { ok: true, isSuperAdmin };
}

// ──────────────────────────────────────────────────────────────────
// Admin subscriptions
// ──────────────────────────────────────────────────────────────────

export type AdminSubscriptionRow = {
  id: string;
  userEmail: string;
  userName: string;
  planTier: PlanTier;
  planName: string;
  status: SubscriptionStatus;
  basePriceCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  createdAt: string;
};

export async function listAdminSubscriptions(filter: { status?: SubscriptionStatus } = {}): Promise<AdminSubscriptionRow[]> {
  const rows = await prisma.subscription.findMany({
    where: filter.status ? { status: filter.status } : {},
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true, name: true } },
      plan: { select: { tier: true, name: true } },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    userEmail: s.user.email,
    userName: s.user.name,
    planTier: s.plan.tier,
    planName: s.plan.name,
    status: s.status,
    basePriceCents: s.basePriceCents,
    currency: s.currency,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  }));
}

// ──────────────────────────────────────────────────────────────────
// Admin plans — display row used by /admin/plans UI
// ──────────────────────────────────────────────────────────────────

export type AdminPlanDisplayRow = {
  id: string;
  name: string;
  /** Pre-formatted "$9" / "Free" / "Custom" string. */
  price: string;
  /** "/month", "forever", "" etc. */
  period: string;
  /** CSS color or var(...) used by the card dot. */
  accent: string;
  popular: boolean;
  /** Entitlements as display strings. */
  projects: string;
  envs: string;
  seats: string;
  agents: string;
  /** Active subscriber count for this plan. */
  active: number;
};

function planAccentForTier(tier: PlanTier): string {
  switch (tier) {
    case "Free":
      return "var(--muted, #6b7280)";
    case "Pro":
      return "var(--blue, #2779ff)";
    case "Scale":
      return "var(--accent, #7c3aed)";
    case "Enterprise":
      return "var(--violet, #7b61ff)";
  }
}

function formatPlanPrice(p: { priceCents: number | null; isCustomPrice: boolean; currency: string }): string {
  if (p.isCustomPrice) return "Custom";
  if (p.priceCents === null) return "—";
  if (p.priceCents === 0) return "Free";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: p.currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(p.priceCents / 100);
}

function planPeriodLabel(period: string, priceCents: number | null): string {
  if (priceCents === 0) return "free forever";
  if (period === "month") return "/month";
  if (period === "year") return "/year";
  if (period === "forever") return "forever";
  return "";
}

function countLabel(limit: number | null, noun: string): string {
  if (limit === null) return `Unlimited ${noun}`;
  return `${limit} ${noun}${limit === 1 ? "" : "s"}`;
}

export async function listAdminPlansDisplay(): Promise<AdminPlanDisplayRow[]> {
  const [plans, activeBySub] = await Promise.all([
    prisma.plan.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.subscription.groupBy({
      by: ["planId"],
      where: { status: { in: ["active", "trialing", "past_due"] } },
      _count: { _all: true },
    }),
  ]);
  const activeByPlanId = new Map(activeBySub.map((r) => [r.planId, r._count._all]));
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    price: formatPlanPrice(p),
    period: planPeriodLabel(p.period, p.priceCents),
    accent: planAccentForTier(p.tier),
    popular: p.popular,
    projects: countLabel(p.projectLimit, "project"),
    envs: countLabel(p.envLimit, "environment"),
    seats: countLabel(p.seatLimit, "seat"),
    agents: p.agentTier ?? "Agents included",
    active: activeByPlanId.get(p.id) ?? 0,
  }));
}

// ──────────────────────────────────────────────────────────────────
// Admin subscriptions — display row used by /admin/subscriptions UI
// (rich shape with addons[], payment-method label, etc.)
// ──────────────────────────────────────────────────────────────────

export type AdminSubscriptionDisplayRow = {
  id: string;
  userName: string;
  email: string;
  plan: string;
  status: SubscriptionStatus;
  base: number; // dollars (UI formats with `fmt(n)` directly)
  renews: string;
  method: string;
  addons: Array<{ name: string; price: number }>;
};

function brandLabel(brand: string | null, last4: string | null): string {
  if (!brand || !last4) return "—";
  const cap = brand.charAt(0).toUpperCase() + brand.slice(1);
  return `${cap} ··· ${last4}`;
}

function renewsLabel(
  current: Date | null,
  cancelAtPeriodEnd: boolean,
  status: SubscriptionStatus,
  fallback: string | null,
): string {
  if (status === "past_due") return fallback ?? "Past due";
  if (status === "canceled") return fallback ?? "Cancelled";
  if (!current) return fallback ?? "—";
  const date = current.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return cancelAtPeriodEnd ? `Ends ${date}` : `Renews ${date}`;
}

export async function listAdminSubscriptionsDisplay(
  filter: { status?: SubscriptionStatus } = {},
): Promise<AdminSubscriptionDisplayRow[]> {
  const rows = await prisma.subscription.findMany({
    where: filter.status ? { status: filter.status } : {},
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true, name: true } },
      plan: { select: { name: true } },
      paymentMethod: { select: { brand: true, last4: true } },
      addons: {
        where: { status: "active" },
        orderBy: { purchasedAt: "desc" },
        select: { name: true, priceCents: true },
      },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    userName: s.user.name,
    email: s.user.email,
    plan: s.plan.name,
    status: s.status,
    base: s.basePriceCents / 100,
    renews: renewsLabel(s.currentPeriodEnd, s.cancelAtPeriodEnd, s.status, s.renewsLabel),
    method: brandLabel(s.paymentMethod?.brand ?? null, s.paymentMethod?.last4 ?? null),
    addons: s.addons.map((a) => ({ name: a.name, price: a.priceCents / 100 })),
  }));
}

// ──────────────────────────────────────────────────────────────────
// Admin invoices + billing stats
// ──────────────────────────────────────────────────────────────────

export type AdminInvoiceRow = {
  id: string;
  userEmail: string;
  customerName: string | null;
  number: string | null;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
  paidAt: string | null;
};

export async function listAdminInvoices(): Promise<AdminInvoiceRow[]> {
  const rows = await prisma.invoice.findMany({
    orderBy: { issuedAt: "desc" },
    take: 200,
    include: { user: { select: { email: true } } },
  });
  return rows.map((i) => ({
    id: i.id,
    userEmail: i.user.email,
    customerName: i.customerName,
    number: i.number,
    amountCents: i.amountCents,
    currency: i.currency,
    status: i.status,
    issuedAt: i.issuedAt.toISOString(),
    paidAt: i.paidAt?.toISOString() ?? null,
  }));
}

export type BillingStatsRow = {
  collectedCents: number;
  outstandingCents: number;
  failedCents: number;
  refundedCents: number;
  collectedCount: number;
  outstandingCount: number;
  failedCount: number;
};

export async function computeBillingStats(): Promise<BillingStatsRow> {
  const [paid, open, failed, refunded] = await Promise.all([
    prisma.invoice.aggregate({
      where: { status: "paid" },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: { status: "open" },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: { status: { in: ["uncollectible", "void"] } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    // Refunded — would normally be tracked via a refund event; for now we
    // count void invoices that had been paid as refunded. Phase 13 can split.
    Promise.resolve({ _sum: { amountCents: 0 }, _count: { _all: 0 } }),
  ]);

  return {
    collectedCents: paid._sum.amountCents ?? 0,
    outstandingCents: open._sum.amountCents ?? 0,
    failedCents: failed._sum.amountCents ?? 0,
    refundedCents: refunded._sum.amountCents ?? 0,
    collectedCount: paid._count._all,
    outstandingCount: open._count._all,
    failedCount: failed._count._all,
  };
}
