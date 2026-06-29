import { NextResponse } from "next/server";
import { PatchPipelineRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getPipeline, patchPipeline } from "@/lib/devops/pipelines";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const pipeline = await getPipeline(gate.access.project.id, id);
  if (!pipeline) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({ pipeline });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PatchPipelineRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await patchPipeline(gate.access.project.id, id, parsed.data);
  if (!res.ok) {
    const status = res.code === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "pipeline.patched",
    targetType: "pipeline",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, pipeline: res.pipeline });
}
