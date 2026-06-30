import { NextResponse } from "next/server";
import { PatchWorkloadRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { deleteWorkload, patchWorkload } from "@/lib/insights/workloads";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PatchWorkloadRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await patchWorkload(gate.access.project.id, id, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "workload.patched",
    targetType: "workload",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, workload: res.workload });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ok = await deleteWorkload(gate.access.project.id, id);
  if (!ok) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "workload.deleted",
    targetType: "workload",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
