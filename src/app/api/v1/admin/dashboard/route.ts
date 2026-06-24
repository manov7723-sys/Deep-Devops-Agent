import { NextResponse } from "next/server";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { computeAdminDashboard } from "@/lib/admin/aggregates";

export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const payload = await computeAdminDashboard();
  return NextResponse.json(payload);
}
