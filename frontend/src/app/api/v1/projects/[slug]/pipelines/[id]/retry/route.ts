import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { retryPipeline } from "@/lib/devops/pipelines";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const res = await retryPipeline(gate.access.project.id, id, gate.access.session.userId);
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "pipeline.retried",
    targetType: "pipeline",
    targetId: res.pipelineId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { retryOf: id },
  });
  return NextResponse.json({ ok: true, pipelineId: res.pipelineId });
}
