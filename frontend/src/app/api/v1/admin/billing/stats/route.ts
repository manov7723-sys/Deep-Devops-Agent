import { NextResponse } from "next/server";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { computeBillingStats } from "@/lib/admin/aggregates";

export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  // Bare object — hook is `api.get<BillingStats>` (no envelope).
  const stats = await computeBillingStats();
  return NextResponse.json(stats);
}
