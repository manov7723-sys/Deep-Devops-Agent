import { NextResponse } from "next/server";
import { UpsertAssetRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { upsertAsset } from "@/lib/admin/platform";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = UpsertAssetRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const asset = await upsertAsset({
    key: parsed.data.key,
    label: parsed.data.label,
    hint: parsed.data.hint,
    url: parsed.data.url ?? null,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.asset_upserted",
    targetType: "platform_asset",
    targetId: parsed.data.key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, asset });
}
