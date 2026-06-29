import { NextResponse } from "next/server";
import { CreatePlanRequest } from "@/lib/api/schemas/billing-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { createPlan } from "@/lib/billing/billing";
import { listAdminPlansDisplay } from "@/lib/admin/aggregates";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Returns a bare array of display-formatted plan rows. The hook is
 * `useAdminPlans()` → `api.get<SeedAdminPlan[]>` which iterates `.map`
 * directly, so no `{plans}` envelope. Use the public `/plans` endpoint
 * for the raw `PlanRow` shape.
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const plans = await listAdminPlansDisplay();
  return NextResponse.json(plans);
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = CreatePlanRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await createPlan({
    tier: parsed.data.tier,
    name: parsed.data.name,
    priceCents: parsed.data.priceCents ?? null,
    isCustomPrice: parsed.data.isCustomPrice,
    currency: parsed.data.currency,
    period: parsed.data.period,
    popular: parsed.data.popular,
    sortOrder: parsed.data.sortOrder,
    stripeProductId: parsed.data.stripeProductId,
    stripePriceId: parsed.data.stripePriceId,
    projectLimit: parsed.data.projectLimit ?? null,
    envLimit: parsed.data.envLimit ?? null,
    seatLimit: parsed.data.seatLimit ?? null,
    agentTier: parsed.data.agentTier,
    highlights: parsed.data.highlights,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: res.code }, { status: 409 });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "billing.plan_created",
    targetType: "plan",
    targetId: res.plan.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { tier: parsed.data.tier },
  });
  return NextResponse.json({ ok: true, plan: res.plan });
}
