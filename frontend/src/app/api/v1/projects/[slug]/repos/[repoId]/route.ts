import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { detachRepoFromProject } from "@/lib/repos/repos";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; repoId: string }> },
) {
  const { slug, repoId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ok = await detachRepoFromProject(gate.access.project.id, repoId);
  if (!ok) {
    return NextResponse.json(
      { ok: false, code: "not_attached", message: "This repo isn't attached to the project." },
      { status: 404 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.detached",
    targetType: "repo",
    targetId: repoId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
