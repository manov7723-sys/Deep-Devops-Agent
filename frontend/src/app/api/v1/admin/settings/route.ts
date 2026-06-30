import { NextResponse } from "next/server";
import { PatchPlatformSettingsRequest } from "@/lib/api/schemas/admin-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import {
  getPlatformSettings,
  listAssets,
  listEnvVars,
  listSystemComponents,
  patchPlatformSettings,
} from "@/lib/admin/platform";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Returns the nested shape `AdminSettingsClient` consumes:
 *   { branding: {siteTitle, metaDescription, assets[]},
 *     email:    {smtpHost, smtpPort, fromAddress, verifiedAt},
 *     envVars[], systemStatus[] }
 * The PATCH below still accepts flat scalar keys.
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const [settings, assets, envVars, systemComponents] = await Promise.all([
    getPlatformSettings(),
    listAssets(),
    listEnvVars(),
    listSystemComponents(),
  ]);
  return NextResponse.json({
    branding: {
      siteTitle: settings.siteTitle ?? "",
      metaDescription: settings.metaDescription ?? "",
      assets,
    },
    email: {
      smtpHost: settings.smtpHost ?? "",
      smtpPort: settings.smtpPort != null ? String(settings.smtpPort) : "",
      fromAddress: settings.fromAddress ?? "",
      verifiedAt: settings.smtpVerifiedAt ?? null,
    },
    envVars,
    systemStatus: systemComponents,
  });
}

export async function PATCH(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = PatchPlatformSettingsRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { smtpVerifiedAt, ...rest } = parsed.data;
  const settings = await patchPlatformSettings({
    ...rest,
    ...(smtpVerifiedAt !== undefined && {
      smtpVerifiedAt: smtpVerifiedAt ? new Date(smtpVerifiedAt) : null,
    }),
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.settings_patched",
    targetType: "platform_setting",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, settings });
}
