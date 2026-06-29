import { NextResponse } from "next/server";
import { CreateKpiRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createKpi } from "@/lib/insights/observability";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = CreateKpiRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  let envId: string | undefined;
  if (parsed.data.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
    if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
    envId = env.id;
  }
  const kpi = await createKpi({
    projectId: gate.access.project.id,
    envId,
    name: parsed.data.name,
    value: parsed.data.value,
    unit: parsed.data.unit,
    tone: parsed.data.tone,
    series: parsed.data.series,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "observability.kpi_created",
    targetType: "kpi",
    targetId: kpi.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: kpi.name, tone: kpi.tone },
  });
  return NextResponse.json({ ok: true, kpi });
}
