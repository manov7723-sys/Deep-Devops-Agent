import { NextResponse } from "next/server";
import { UpdateIntegrationRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { deleteIntegration, updateIntegration } from "@/lib/integrations/integrations";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = UpdateIntegrationRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid update.",
      },
      { status: 400 },
    );
  }
  const res = await updateIntegration(gate.access.project.id, id, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "integration.updated",
    targetType: "integration",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const res = await deleteIntegration(gate.access.project.id, id);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "integration.disconnected",
    targetType: "integration",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
