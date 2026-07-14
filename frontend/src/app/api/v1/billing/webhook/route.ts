import { NextResponse } from "next/server";
import type { CardBrand, InvoiceStatus, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { verifyWebhook, type StripeEvent } from "@/lib/billing/stripe";
import {
  findPlanByStripePriceId,
  findUserByStripeCustomerId,
  markStripeEventProcessed,
  recordStripeEvent,
  upsertInvoice,
  upsertPaymentMethod,
  upsertSubscription,
} from "@/lib/billing/billing";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Stripe webhook. The body must be read as raw text BEFORE parsing JSON so the
 * HMAC verifier sees the same bytes Stripe signed. Idempotency: every event id
 * is persisted via recordStripeEvent on insert; a duplicate ID short-circuits.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const sigHeader = req.headers.get("stripe-signature");

  const verified = await verifyWebhook(raw, sigHeader);
  if (!verified.ok) {
    return NextResponse.json({ ok: false, code: verified.code }, { status: 400 });
  }
  const event = verified.event;

  const stored = await recordStripeEvent({
    id: event.id,
    type: event.type,
    apiVersion: event.api_version,
    payload: event,
  });
  if (stored.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const meta = extractRequestMeta(req);
  await audit({
    action: "billing.webhook_received",
    targetType: "stripe_event",
    targetId: event.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { type: event.type },
  });

  try {
    await dispatch(event);
    await markStripeEventProcessed(event.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markStripeEventProcessed(event.id, message);
    console.error(`[stripe] dispatch ${event.type} failed:`, message);
    // Return 200 anyway so Stripe doesn't endlessly retry on a non-recoverable
    // payload — the StripeEvent row records the failure for forensics.
    return NextResponse.json({ ok: false, code: "dispatch_failed", message }, { status: 200 });
  }
}

async function dispatch(event: StripeEvent): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscription(event);
      return;
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.finalized":
      await handleInvoice(event);
      return;
    case "payment_method.attached":
    case "payment_method.updated":
      await handlePaymentMethodAttached(event);
      return;
    case "checkout.session.completed":
      await handleCheckoutCompleted(event);
      return;
    default:
      return;
  }
}

async function handleSubscription(event: StripeEvent): Promise<void> {
  const sub = event.data.object as {
    id: string;
    customer: string;
    status: string;
    cancel_at_period_end?: boolean;
    current_period_start?: number;
    current_period_end?: number;
    trial_end?: number | null;
    canceled_at?: number | null;
    currency?: string;
    items?: { data: Array<{ price: { id: string; unit_amount: number } }> };
  };
  const user = await findUserByStripeCustomerId(sub.customer);
  if (!user) return;

  const item = sub.items?.data[0];
  const stripePriceId = item?.price.id;
  if (!stripePriceId) return;
  const plan = await findPlanByStripePriceId(stripePriceId);
  if (!plan) return;

  await upsertSubscription({
    userId: user.id,
    stripeSubscriptionId: sub.id,
    stripePriceId,
    status: sub.status as SubscriptionStatus,
    basePriceCents: item?.price.unit_amount ?? plan.priceCents ?? 0,
    currency: sub.currency ?? plan.currency,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodStart: sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : undefined,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : undefined,
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : undefined,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : undefined,
    planId: plan.id,
  });
  await audit({
    userId: user.id,
    action: "billing.subscription_synced",
    targetType: "subscription",
    targetId: sub.id,
    metadata: { status: sub.status, planTier: plan.tier },
  });
}

async function handleInvoice(event: StripeEvent): Promise<void> {
  const inv = event.data.object as {
    id: string;
    customer: string;
    number?: string;
    customer_name?: string;
    amount_due: number;
    currency: string;
    status: string;
    hosted_invoice_url?: string;
    invoice_pdf?: string;
    created: number;
    status_transitions?: { paid_at?: number | null };
  };
  const user = await findUserByStripeCustomerId(inv.customer);
  if (!user) return;
  await upsertInvoice({
    userId: user.id,
    stripeInvoiceId: inv.id,
    number: inv.number,
    customerName: inv.customer_name,
    amountCents: inv.amount_due,
    currency: inv.currency,
    status: inv.status as InvoiceStatus,
    hostedInvoiceUrl: inv.hosted_invoice_url,
    pdfUrl: inv.invoice_pdf,
    issuedAt: new Date(inv.created * 1000),
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000)
      : undefined,
  });
  await audit({
    userId: user.id,
    action: "billing.invoice_synced",
    targetType: "invoice",
    targetId: inv.id,
    metadata: { status: inv.status, amountCents: inv.amount_due },
  });
}

async function handlePaymentMethodAttached(event: StripeEvent): Promise<void> {
  const pm = event.data.object as {
    id: string;
    customer: string;
    card?: { brand: string; last4: string; exp_month: number; exp_year: number };
    metadata?: { isDefault?: string };
  };
  if (!pm.card) return;
  const user = await findUserByStripeCustomerId(pm.customer);
  if (!user) return;
  await upsertPaymentMethod({
    userId: user.id,
    stripePaymentMethodId: pm.id,
    brand: normaliseBrand(pm.card.brand),
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
    isDefault: pm.metadata?.isDefault === "true",
  });
  await audit({
    userId: user.id,
    action: "billing.payment_method_synced",
    targetType: "payment_method",
    targetId: pm.id,
    metadata: { brand: pm.card.brand },
  });
}

/**
 * Token top-up dispatch. Fires when a Checkout Session reaches `complete`,
 * which is how `mode=payment` (one-charge) flows confirm. For the addon path:
 *   - look up the Addon by metadata.addonId (set by /billing/checkout),
 *   - credit Usage.tokensGranted by addon.tokenGrant,
 *   - record a SubscriptionAddon row for forensics.
 * Idempotent: if a SubscriptionAddon already exists for this Checkout Session
 * we skip — Stripe may redeliver the event.
 */
async function handleCheckoutCompleted(event: StripeEvent): Promise<void> {
  const sess = event.data.object as {
    id: string;
    customer: string;
    mode: "subscription" | "setup" | "payment";
    payment_status?: string;
    metadata?: { userId?: string; purpose?: string; addonId?: string; planId?: string };
    amount_total?: number;
    currency?: string;
  };

  if (sess.mode !== "payment") return; // subscriptions handled elsewhere
  if (sess.payment_status && sess.payment_status !== "paid") return;

  const addonId = sess.metadata?.addonId;
  if (!addonId) return;

  const user = await findUserByStripeCustomerId(sess.customer);
  if (!user) return;

  const addon = await prisma.addon.findUnique({ where: { id: addonId } });
  if (!addon) return;

  // Idempotency — Stripe can redeliver. We use the Checkout Session id as the
  // stripeSubscriptionItemId since it's globally unique.
  const dup = await prisma.subscriptionAddon.findUnique({
    where: { stripeSubscriptionItemId: sess.id },
    select: { id: true },
  });
  if (dup) return;

  // Locate the buyer's current Subscription (if any) — token-pack purchases
  // don't require a subscription, but Subscription is where the addon row
  // lives in the schema, so we lazily create a "passthrough" sub record for
  // users who paid for tokens before they ever subscribed.
  let subscriptionId = (
    await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { id: true },
    })
  )?.id;
  if (!subscriptionId) {
    // Find or create the placeholder "Free" plan so token-pack-only buyers
    // still have a subscription row to attach SubscriptionAddon to.
    const freePlan = await prisma.plan.findFirst({ where: { tier: "Free" } });
    if (freePlan) {
      const created = await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          status: "active",
          basePriceCents: freePlan.priceCents ?? 0,
          currency: freePlan.currency,
        },
        select: { id: true },
      });
      subscriptionId = created.id;
    }
  }

  if (subscriptionId) {
    await prisma.subscriptionAddon.create({
      data: {
        subscriptionId,
        addonId: addon.id,
        name: addon.name,
        icon: addon.icon,
        priceCents: addon.priceCents,
        status: "active",
        stripeSubscriptionItemId: sess.id,
      },
    });
  }

  // Credit the tokens — upsert the Usage row if it doesn't exist yet.
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await prisma.usage.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      periodStart,
      periodEnd,
      tokensGranted: BigInt(addon.tokenGrant),
    },
    update: {
      tokensGranted: { increment: BigInt(addon.tokenGrant) },
    },
  });

  await audit({
    userId: user.id,
    action: "billing.invoice_synced",
    targetType: "checkout_session",
    targetId: sess.id,
    metadata: {
      addonId: addon.id,
      addonName: addon.name,
      tokenGrant: addon.tokenGrant,
      amountCents: sess.amount_total ?? addon.priceCents,
    },
  });
}

function normaliseBrand(brand: string): CardBrand {
  const lower = brand.toLowerCase();
  if (lower === "visa") return "visa";
  if (lower === "mastercard") return "mastercard";
  if (lower === "amex" || lower === "american_express") return "amex";
  if (lower === "discover") return "discover";
  if (lower === "diners") return "diners";
  if (lower === "jcb") return "jcb";
  if (lower === "unionpay") return "unionpay";
  return "unknown";
}
