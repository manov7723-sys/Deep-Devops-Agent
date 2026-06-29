import { NextResponse } from "next/server";
import { PatchAgentRequest } from "@/lib/api/schemas/admin-catalog-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { deleteAgent, patchAgent } from "@/lib/admin/catalog";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;
  const parsed = PatchAgentRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await patchAgent(id, parsed.data);
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.agent_patched",
    targetType: "agent",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, agent: res.agent });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;
  const res = await deleteAgent(id);
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.agent_deleted",
    targetType: "agent",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
