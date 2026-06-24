import { NextResponse } from "next/server";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { listAdminInvoicesDisplay } from "@/lib/admin/aggregates";

/**
 * Bare array of display-formatted invoice rows for the admin billing
 * table (the hook iterates `.map`/`.filter` directly — no envelope).
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const invoices = await listAdminInvoicesDisplay();
  return NextResponse.json(invoices);
}
