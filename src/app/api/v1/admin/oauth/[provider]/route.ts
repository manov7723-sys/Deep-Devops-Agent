import { NextResponse } from "next/server";
import { z } from "zod";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { clearOAuthConfig, setOAuthEnabled } from "@/lib/admin/oauth-config";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const ProviderParam = z.enum(["github", "google"]);
const PatchRequest = z.object({ enabled: z.boolean() });

/** PATCH → toggle the `enabled` flag without touching the secret. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { provider } = await ctx.params;
  const p = ProviderParam.safeParse(provider);
  if (!p.success) {
    return NextResponse.json(
      { ok: false, code: "unknown_provider" },
      { status: 404 },
    );
  }
  const parsed = PatchRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  try {
    await setOAuthEnabled(p.data, parsed.data.enabled);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: "not_configured",
        message: "Configure the provider first by saving a client ID and secret.",
      },
      { status: 404 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.oauth_config_upserted",
    targetType: "oauth_provider",
    targetId: p.data,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { provider: p.data, enabled: parsed.data.enabled },
  });
  return NextResponse.json({ ok: true });
}

/** DELETE → drop the row. `getProviderAsync()` then falls back to env vars. */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const { provider } = await ctx.params;
  const p = ProviderParam.safeParse(provider);
  if (!p.success) {
    return NextResponse.json(
      { ok: false, code: "unknown_provider" },
      { status: 404 },
    );
  }
  await clearOAuthConfig(p.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.oauth_config_cleared",
    targetType: "oauth_provider",
    targetId: p.data,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
