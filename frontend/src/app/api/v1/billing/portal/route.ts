import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { createPortalSession, StripeApiError } from "@/lib/billing/stripe";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

function isLikelyRealStripeId(id: string | null): boolean {
  return !!id && /^cus_[A-Za-z0-9]{14,}$/.test(id) && !id.startsWith("cus_mock_");
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const user = await prisma.user.findUnique({
    where: { id: sess.userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId || !isLikelyRealStripeId(user.stripeCustomerId)) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_customer",
        message: "Subscribe to a plan first — the customer portal opens once you have a real Stripe customer record.",
      },
      { status: 400 },
    );
  }
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  try {
    const portal = await createPortalSession({
      customerId: user.stripeCustomerId,
      returnUrl: `${origin}/u/subscription`,
    });
    const meta = extractRequestMeta(req);
    await audit({
      userId: sess.userId,
      action: "billing.portal_opened",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return NextResponse.json({ ok: true, url: portal.url });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error(`[portal] ${err.message}`);
      return NextResponse.json(
        { ok: false, code: `stripe_${err.code}`, message: err.stripeMessage },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[portal] unexpected: ${message}`);
    return NextResponse.json(
      { ok: false, code: "portal_failed", message },
      { status: 500 },
    );
  }
}
