import { NextResponse } from "next/server";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { listAdminUsers } from "@/lib/admin/aggregates";

export async function GET(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  const users = await listAdminUsers({ q });
  // Bare array — `useAdminUsers()` reads it with `.map`/`.filter` directly.
  return NextResponse.json(users);
}
