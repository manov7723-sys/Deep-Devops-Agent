import { NextResponse } from "next/server";
import { CreateMcpRequest } from "@/lib/api/schemas/admin-catalog-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { createMcp, listMcp } from "@/lib/admin/catalog";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Bare array — `useAdminMcpList()` iterates `.map` directly with no envelope. */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const connectors = await listMcp();
  return NextResponse.json(connectors);
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = CreateMcpRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const connector = await createMcp(parsed.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.mcp_created",
    targetType: "mcp_connector",
    targetId: connector.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: connector.name, authType: connector.authType },
  });
  return NextResponse.json({ ok: true, connector });
}
