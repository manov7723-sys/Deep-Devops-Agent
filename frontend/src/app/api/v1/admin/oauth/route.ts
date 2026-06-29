import { NextResponse } from "next/server";
import { z } from "zod";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { listOAuthConfigs, upsertOAuthConfig } from "@/lib/admin/oauth-config";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const UpsertOAuthConfigRequest = z.object({
  provider: z.enum(["github", "google"]),
  clientId: z.string().trim().min(1, "Client ID is required").max(255),
  /** Empty / omitted = keep existing secret. */
  clientSecret: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  enabled: z.boolean().optional(),
});

/**
 * GET → list every configured OAuth provider with a masked secret preview.
 *       Bare array so the UI can `.map()` directly.
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const rows = await listOAuthConfigs();
  return NextResponse.json(rows);
}

/**
 * POST → upsert one provider. Pass `clientSecret` to rotate; omit to leave
 *        the stored secret untouched (e.g. when fixing a typo in the ID).
 */
export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const raw = await req.json().catch(() => ({}));
  const parsed = UpsertOAuthConfigRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  try {
    const row = await upsertOAuthConfig({
      provider: parsed.data.provider,
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      enabled: parsed.data.enabled,
    });
    const meta = extractRequestMeta(req);
    await audit({
      userId: gate.session.userId,
      action: "admin.oauth_config_upserted",
      targetType: "oauth_provider",
      targetId: parsed.data.provider,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        provider: parsed.data.provider,
        rotatedSecret: !!parsed.data.clientSecret,
        enabled: parsed.data.enabled ?? row.enabled,
      },
    });
    return NextResponse.json({ ok: true, config: row });
  } catch (e) {
    if (e instanceof Error && e.message === "client_secret_required") {
      return NextResponse.json(
        {
          ok: false,
          code: "client_secret_required",
          message: "Client secret is required when configuring a provider for the first time.",
        },
        { status: 400 },
      );
    }
    throw e;
  }
}
