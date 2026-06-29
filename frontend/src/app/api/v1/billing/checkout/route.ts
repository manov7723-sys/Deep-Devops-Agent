import { NextResponse } from "next/server";
import { CheckoutRequest } from "@/lib/api/schemas/billing-api";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import {
  attachStripeCustomerId,
  recordCheckoutSession,
} from "@/lib/billing/billing";
import {
  createCheckoutSession,
  createStripeCustomer,
  updateSubscriptionPrice,
  StripeApiError,
} from "@/lib/billing/stripe";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * What "looks like" a Stripe customer id from the real API.
 * Real ones are `cus_` + ≥14 chars of base62 (e.g. cus_NHN1jL9NWPbFW0).
 * The old code used `cus_${userId.slice(-12)}` which leaves 16 chars total —
 * too short for a real Stripe customer id, AND uses cuid characters that
 * happen to overlap with Stripe's alphabet, so we treat anything shorter as
 * synthetic and discard it before re-using.
 */
function isLikelyRealStripeId(id: string | null): boolean {
  return !!id && /^cus_[A-Za-z0-9]{14,}$/.test(id) && !id.startsWith("cus_mock_");
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = CheckoutRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const successUrl = `${origin}/u/subscription?checkout=success`;
  const cancelUrl = `${origin}/u/subscription?checkout=cancelled`;

  let mode: "subscription" | "setup" | "payment";
  let priceId: string | undefined;
  let metadata: Record<string, string> = { userId: sess.userId, purpose: parsed.data.purpose };
  const purposeLabel = parsed.data.purpose;

  if (parsed.data.purpose === "new_subscription") {
    const plan = await prisma.plan.findUnique({ where: { id: parsed.data.planId } });
    if (!plan) return NextResponse.json({ ok: false, code: "plan_not_found" }, { status: 404 });
    if (!plan.stripePriceId) {
      return NextResponse.json(
        { ok: false, code: "plan_not_purchasable", message: "This plan has no Stripe price configured." },
        { status: 400 },
      );
    }

    // Switch-in-place when an existing active/trialing subscription is found.
    // Stripe updates the same Subscription onto the new price (with proration);
    // no second Checkout session is created and the old plan is implicitly
    // ended (Stripe sets the line item end → start of new line item).
    const existing = await prisma.subscription.findUnique({
      where: { userId: sess.userId },
      select: {
        id: true,
        planId: true,
        status: true,
        stripeSubscriptionId: true,
        stripePriceId: true,
      },
    });
    const SWITCHABLE_STATUSES = new Set(["active", "trialing", "past_due"]);
    if (
      existing &&
      existing.stripeSubscriptionId &&
      SWITCHABLE_STATUSES.has(existing.status)
    ) {
      if (existing.planId === plan.id || existing.stripePriceId === plan.stripePriceId) {
        return NextResponse.json(
          { ok: false, code: "same_plan", message: "You're already on this plan." },
          { status: 409 },
        );
      }
      try {
        const updated = await updateSubscriptionPrice({
          subscriptionId: existing.stripeSubscriptionId,
          newPriceId: plan.stripePriceId,
        });
        const reqMeta = extractRequestMeta(req);
        await audit({
          userId: sess.userId,
          action: "billing.subscription_switched",
          targetType: "subscription",
          targetId: existing.stripeSubscriptionId,
          ipAddress: reqMeta.ipAddress,
          userAgent: reqMeta.userAgent,
          metadata: { fromPlanId: existing.planId, toPlanId: plan.id, newPriceId: plan.stripePriceId },
        });
        return NextResponse.json({
          ok: true,
          switched: true,
          subscriptionId: updated.id,
          status: updated.status,
          redirect: `${origin}/u/subscription?switched=success`,
        });
      } catch (err) {
        if (err instanceof StripeApiError) {
          console.error(`[switch-plan] ${err.message}`);
          return NextResponse.json(
            { ok: false, code: `stripe_${err.code}`, message: err.stripeMessage },
            { status: 400 },
          );
        }
        throw err;
      }
    }

    mode = "subscription";
    priceId = plan.stripePriceId;
    metadata = { ...metadata, planId: plan.id };
  } else if (parsed.data.purpose === "add_addon") {
    const addon = await prisma.addon.findUnique({ where: { id: parsed.data.addonId } });
    if (!addon) return NextResponse.json({ ok: false, code: "addon_not_found" }, { status: 404 });
    if (!addon.stripePriceId) {
      return NextResponse.json(
        { ok: false, code: "addon_not_purchasable" },
        { status: 400 },
      );
    }
    mode = "payment";
    priceId = addon.stripePriceId;
    metadata = { ...metadata, addonId: addon.id };
  } else {
    mode = "setup";
  }

  const userRow = await prisma.user.findUnique({
    where: { id: sess.userId },
    select: { stripeCustomerId: true, email: true, name: true },
  });
  if (!userRow) return NextResponse.json({ ok: false }, { status: 401 });

  try {
    // Get or create a REAL Stripe customer. The old synthetic-id path is
    // gone — passing a fake customer to /checkout/sessions yields
    // "No such customer" from Stripe's API and a 500 from the client.
    let customerId = userRow.stripeCustomerId;
    if (!isLikelyRealStripeId(customerId)) {
      const created = await createStripeCustomer({
        email: userRow.email,
        name: userRow.name,
        metadata: { dda_user_id: sess.userId },
      });
      customerId = created.id;
      await attachStripeCustomerId(sess.userId, customerId);
    }

    const checkout = await createCheckoutSession({
      mode,
      customerEmail: userRow.email,
      customerId,
      priceId,
      successUrl,
      cancelUrl,
      metadata,
    });

    await recordCheckoutSession({
      id: checkout.id,
      userId: sess.userId,
      mode,
      purpose: purposeLabel,
    });

    const reqMeta = extractRequestMeta(req);
    await audit({
      userId: sess.userId,
      action: "billing.checkout_started",
      targetType: "checkout_session",
      targetId: checkout.id,
      ipAddress: reqMeta.ipAddress,
      userAgent: reqMeta.userAgent,
      metadata: { purpose: purposeLabel, mode },
    });
    return NextResponse.json({ ok: true, url: checkout.url, id: checkout.id });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error(`[checkout] ${err.message}`);
      return NextResponse.json(
        {
          ok: false,
          code: `stripe_${err.code}`,
          message: err.stripeMessage,
        },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[checkout] unexpected: ${message}`);
    return NextResponse.json(
      { ok: false, code: "checkout_failed", message },
      { status: 500 },
    );
  }
}
