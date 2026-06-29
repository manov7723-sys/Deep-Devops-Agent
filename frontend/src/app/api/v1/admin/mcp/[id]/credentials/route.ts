import { NextResponse } from "next/server";
import { UpsertMcpCredentialRequest } from "@/lib/api/schemas/admin-catalog-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { upsertMcpCredential } from "@/lib/admin/catalog";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { id } = await ctx.params;
  const parsed = UpsertMcpCredentialRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await upsertMcpCredential(
    id,
    parsed.data.key,
    parsed.data.value,
    parsed.data.isSecret,
  );
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.mcp_credential_upserted",
    targetType: "mcp_credential",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { key: parsed.data.key },
  });
  return NextResponse.json({ ok: true });
}
