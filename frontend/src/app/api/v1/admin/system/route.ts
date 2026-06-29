import { NextResponse } from "next/server";
import { UpsertSystemComponentRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { listSystemComponents, upsertSystemComponent } from "@/lib/admin/platform";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const components = await listSystemComponents();
  return NextResponse.json({ components });
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = UpsertSystemComponentRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const component = await upsertSystemComponent({
    key: parsed.data.key,
    name: parsed.data.name,
    status: parsed.data.status,
    note: parsed.data.note,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.system_component_upserted",
    targetType: "system_component",
    targetId: parsed.data.key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { status: parsed.data.status },
  });
  return NextResponse.json({ ok: true, component });
}
