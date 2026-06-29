import { NextResponse } from "next/server";
import { UpsertEnvVarRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { upsertEnvVar } from "@/lib/admin/platform";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = UpsertEnvVarRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const envVar = await upsertEnvVar({
    key: parsed.data.key,
    value: parsed.data.value,
    status: parsed.data.status,
    statusLabel: parsed.data.statusLabel,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.env_var_upserted",
    targetType: "platform_env_var",
    targetId: parsed.data.key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, envVar });
}
