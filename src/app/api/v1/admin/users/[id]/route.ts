import { NextResponse } from "next/server";
import { PatchAdminUserRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { setSuperAdmin } from "@/lib/admin/aggregates";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;
  const parsed = PatchAdminUserRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  if (parsed.data.isSuperAdmin !== undefined) {
    const res = await setSuperAdmin(
      { userId: gate.session.userId },
      id,
      parsed.data.isSuperAdmin,
    );
    if (!res.ok) {
      const status =
        res.code === "not_found" ? 404 :
        res.code === "self_demote" || res.code === "last_admin_demote" ? 409 :
        400;
      return NextResponse.json({ ok: false, code: res.code }, { status });
    }
    const meta = extractRequestMeta(req);
    await audit({
      userId: gate.session.userId,
      action: res.isSuperAdmin ? "admin.user_promoted" : "admin.user_demoted",
      targetType: "user",
      targetId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return NextResponse.json({ ok: true, isSuperAdmin: res.isSuperAdmin });
  }

  return NextResponse.json({ ok: true });
}
