import { NextResponse } from "next/server";
import { CreateTargetRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createTarget } from "@/lib/insights/observability";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = CreateTargetRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const target = await createTarget(gate.access.project.id, parsed.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "observability.target_created",
    targetType: "prometheus_target",
    targetId: target.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true, target });
}
