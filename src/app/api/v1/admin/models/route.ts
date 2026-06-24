import { NextResponse } from "next/server";
import { CreateModelRequest } from "@/lib/api/schemas/admin-catalog-api";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { createModel, listModelsDisplay } from "@/lib/admin/catalog";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Bare array — hook iterates `.map`/`.filter` with no envelope. The list
 * auto-seeds Claude / GPT / Groq rows when the catalog is empty so the
 * page is never blank.
 */
export async function GET() {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const models = await listModelsDisplay();
  return NextResponse.json(models);
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);
  const parsed = CreateModelRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const model = await createModel(parsed.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.model_created",
    targetType: "model",
    targetId: model.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { provider: model.provider, isDefault: model.isDefault },
  });
  return NextResponse.json({ ok: true, model });
}
