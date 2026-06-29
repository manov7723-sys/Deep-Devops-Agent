import { NextResponse } from "next/server";
import type { SubscriptionStatus } from "@prisma/client";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { listAdminSubscriptionsDisplay } from "@/lib/admin/aggregates";

/**
 * Returns a bare array (the `AdminSubscriptionsClient` hook does
 * `api.get<SeedAdminSubscription[]>` and iterates `.reduce`/`.filter`
 * directly). The rich shape includes:
 *   - `base` (dollars), `addons[]` (also dollars), `renews`/`method`
 *     display strings — for the totals + cards in the page.
 */
export async function GET(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const statusParam = new URL(req.url).searchParams.get("status");
  const filter = isStatus(statusParam) ? { status: statusParam } : undefined;
  const subscriptions = await listAdminSubscriptionsDisplay(filter);
  return NextResponse.json(subscriptions);
}

function isStatus(v: string | null): v is SubscriptionStatus {
  return (
    v === "trialing" || v === "active" || v === "past_due" ||
    v === "canceled" || v === "unpaid" || v === "incomplete" ||
    v === "incomplete_expired" || v === "paused"
  );
}
