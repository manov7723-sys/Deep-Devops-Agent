import { NextResponse } from "next/server";
import { CreateAddonRequest } from "@/lib/api/schemas/billing-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { createAddon } from "@/lib/billing/billing";
import { listAdminAddonPurchases } from "@/lib/admin/aggregates";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * GET — returns the per-user PURCHASE history (SubscriptionAddon rows joined
 * to Subscription → User) shaped for the `AdminAddonsClient` table. The
 * catalog (Addon catalog) lives at the public GET /addons.
 *
 * The hook unwraps a bare array, so this responds with the array directly
 * (no `{purchases}` envelope) — keep aligned with `useAdminAddons`.
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const purchases = await listAdminAddonPurchases();
  return NextResponse.json(purchases);
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = CreateAddonRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const addon = await createAddon(parsed.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "billing.addon_created",
    targetType: "addon",
    targetId: addon.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: addon.name },
  });
  return NextResponse.json({ ok: true, addon });
}
