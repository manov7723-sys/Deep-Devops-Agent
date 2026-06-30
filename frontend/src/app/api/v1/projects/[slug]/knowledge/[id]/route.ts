import { NextResponse } from "next/server";
import { PatchKnowledgeRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { deleteKnowledge, getKnowledge, patchKnowledge } from "@/lib/agentops/knowledge";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const doc = await getKnowledge(gate.access.project.id, id);
  if (!doc) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PatchKnowledgeRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const res = await patchKnowledge(gate.access.project.id, id, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "knowledge.patched",
    targetType: "knowledge",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ ok: true, doc: res.doc });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ok = await deleteKnowledge(gate.access.project.id, id);
  if (!ok) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "knowledge.deleted",
    targetType: "knowledge",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
